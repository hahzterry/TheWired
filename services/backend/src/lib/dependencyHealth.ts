import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { getRedis } from "./redis.js";
import { getMeilisearchClient } from "./meilisearch.js";
import { createSingleFlight } from "./singleFlight.js";
import {
  DEPENDENCIES,
  dependencyCheckDuration,
  dependencyCheckFailures,
  dependencyLastCheck,
  dependencyLastSuccess,
  dependencyUp,
  type Dependency,
} from "./metrics/index.js";

/** Per-dependency probe budget. Docker's healthcheck allows the request 5 s. */
export const CHECK_TIMEOUT_MS = 2000;

export type CheckStatus = "ok" | "down";
export type DependencyStatus = Record<Dependency, CheckStatus>;

const PROBES: Record<Dependency, () => Promise<unknown>> = {
  postgres: () => db.execute(sql`SELECT 1`),
  redis: () => getRedis().ping(),
  meilisearch: () => getMeilisearchClient().health(),
};

/** A dependency has at most one probe outstanding: a caller that arrives
 *  while one is in flight waits on it (with its own budget) instead of adding
 *  another query to a dependency that is not answering. See singleFlight.ts. */
const probes = createSingleFlight<Dependency>();

interface ProbeResult {
  status: CheckStatus;
  /** Why it is down (error message, or "timeout"); empty when ok. */
  reason: string;
  durationSec: number;
}

/** "ok" if the probe settles within the budget, "down" on error or timeout.
 *  ioredis queues commands while reconnecting, so a dead Redis would hang a
 *  bare `ping()` rather than reject; the timeout is what reports it. */
async function check(dependency: Dependency): Promise<ProbeResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS);
  });
  const startedAt = performance.now();
  let status: CheckStatus = "ok";
  let reason = "";
  try {
    await Promise.race([probes.run(dependency, PROBES[dependency]), timeout]);
  } catch (err) {
    status = "down";
    reason = (err as Error)?.message || "probe failed";
  } finally {
    clearTimeout(timer);
  }
  return { status, reason, durationSec: (performance.now() - startedAt) / 1000 };
}

async function checkAll(): Promise<Record<Dependency, ProbeResult>> {
  const results = await Promise.all(DEPENDENCIES.map((d) => check(d)));
  return Object.fromEntries(DEPENDENCIES.map((d, i) => [d, results[i]])) as Record<Dependency, ProbeResult>;
}

/**
 * Probe Postgres, Redis and Meilisearch once, in parallel, and report.
 *
 * Read-only: it records nothing. This is what the public `GET /health` uses,
 * so nobody outside can move the dependency gauges or their failure counter
 * by calling it.
 */
export async function checkDependencies(): Promise<DependencyStatus> {
  const results = await checkAll();
  return Object.fromEntries(DEPENDENCIES.map((d) => [d, results[d].status])) as DependencyStatus;
}

/** What the previous recorded probe of each dependency said, to log only
 *  transitions. */
const lastStatus = new Map<Dependency, CheckStatus>();

/**
 * Probe the dependencies and publish the result: the `backend_dependency_*`
 * metrics, and one log line when a dependency goes down or comes back.
 *
 * Only the metrics sampler calls this, on its own fixed interval, so the
 * gauges and the failure counter have exactly one writer with a known cadence.
 */
export async function recordDependencyHealth(): Promise<DependencyStatus> {
  const results = await checkAll();
  const nowSec = Date.now() / 1000;

  for (const dependency of DEPENDENCIES) {
    const { status, reason, durationSec } = results[dependency];
    dependencyCheckDuration.set({ dependency }, durationSec);
    dependencyLastCheck.set({ dependency }, nowSec);
    dependencyUp.set({ dependency }, status === "ok" ? 1 : 0);
    if (status === "ok") {
      dependencyLastSuccess.set({ dependency }, nowSec);
    } else {
      dependencyCheckFailures.inc({ dependency });
      // Make "never succeeded" an explicit 0 rather than a missing series, so
      // an alert on the timestamp's age fires for a dependency down since boot.
      if (dependencyLastSuccess.get({ dependency }) === undefined) dependencyLastSuccess.set({ dependency }, 0);
    }

    // One line per transition, never per probe: a dependency that stays down
    // (or up) is silent after the first report.
    const previous = lastStatus.get(dependency);
    lastStatus.set(dependency, status);
    if (status === "down" && previous !== "down") {
      console.error(`[health] ${dependency} is down: ${reason}`);
    } else if (status === "ok" && previous === "down") {
      console.warn(`[health] ${dependency} recovered`);
    }
  }
  return Object.fromEntries(DEPENDENCIES.map((d) => [d, results[d].status])) as DependencyStatus;
}

/** Forget transition and in-flight state (tests). */
export function resetDependencyState(): void {
  lastStatus.clear();
  probes.clear();
}
