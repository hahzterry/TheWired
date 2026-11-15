import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { getRedis } from "./redis.js";
import { getMeilisearchClient } from "./meilisearch.js";
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

/** What the previous probe of each dependency said, to log only transitions. */
const lastStatus = new Map<Dependency, CheckStatus>();

/** "ok" if the probe settles within the budget, "down" on error or timeout.
 *  ioredis queues commands while reconnecting, so a dead Redis would hang a
 *  bare `ping()` rather than reject; the timeout is what reports it. */
async function check(dependency: Dependency): Promise<CheckStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS);
  });
  const startedAt = performance.now();
  let status: CheckStatus;
  let reason = "";
  try {
    await Promise.race([PROBES[dependency](), timeout]);
    status = "ok";
  } catch (err) {
    status = "down";
    reason = (err as Error)?.message ?? "";
  } finally {
    clearTimeout(timer);
  }

  const nowSec = Date.now() / 1000;
  dependencyCheckDuration.set({ dependency }, (performance.now() - startedAt) / 1000);
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
    console.error(`[health] ${dependency} is down: ${reason || "probe failed"}`);
  } else if (status === "ok" && previous === "down") {
    console.warn(`[health] ${dependency} recovered`);
  }
  return status;
}

/** Probe Postgres, Redis and Meilisearch once, in parallel, and publish the
 *  result to the dependency gauges. Shared by GET /health (live answer) and
 *  the metrics sampler (so the gauges move without anyone calling /health). */
export async function checkDependencies(): Promise<DependencyStatus> {
  const results = await Promise.all(DEPENDENCIES.map((d) => check(d)));
  return Object.fromEntries(DEPENDENCIES.map((d, i) => [d, results[i]])) as DependencyStatus;
}

/** Forget transition state (tests). */
export function resetDependencyState(): void {
  lastStatus.clear();
}
