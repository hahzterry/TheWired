/**
 * Dependency gauges: `backend_dependency_up` flips when a dependency's client
 * errors or hangs, and `…_last_success_timestamp_seconds` stops advancing —
 * the signal that would have caught a search engine crash-looping for weeks.
 *
 * Two entry points share the probes: `recordDependencyHealth` (the sampler:
 * probes and publishes) and `checkDependencies` (`GET /health`: probes and
 * reports, records nothing).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getMeilisearchClient } from "../../src/lib/meilisearch.js";
import { getRedis } from "../../src/lib/redis.js";
import { db } from "../../src/db/connection.js";
import type { FastifyInstance } from "fastify";
import { buildTestServer, closeTestServer } from "../helpers/testServer.js";
import {
  checkDependencies,
  recordDependencyHealth,
  resetDependencyState,
  CHECK_TIMEOUT_MS,
} from "../../src/lib/dependencyHealth.js";
import {
  registry,
  dependencyUp,
  dependencyLastSuccess,
  dependencyLastCheck,
  dependencyCheckFailures,
  dependencyCheckDuration,
} from "../../src/lib/metrics/index.js";

let meiliHealth: ReturnType<typeof vi.fn>;

beforeEach(() => {
  meiliHealth = getMeilisearchClient().health as unknown as ReturnType<typeof vi.fn>;
  meiliHealth.mockReset();
  meiliHealth.mockResolvedValue({ status: "available" });
  for (const m of [dependencyUp, dependencyLastSuccess, dependencyLastCheck, dependencyCheckFailures, dependencyCheckDuration]) {
    m.reset();
  }
  resetDependencyState();
});

afterEach(() => {
  meiliHealth.mockReset();
  meiliHealth.mockResolvedValue({ status: "available" });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("dependency gauges", () => {
  it("reports every dependency up with a fresh last-success timestamp", async () => {
    const before = Date.now() / 1000;
    expect(await recordDependencyHealth()).toEqual({ postgres: "ok", redis: "ok", meilisearch: "ok" });
    for (const dependency of ["postgres", "redis", "meilisearch"] as const) {
      expect(dependencyUp.get({ dependency })).toBe(1);
      expect(dependencyLastSuccess.get({ dependency })).toBeGreaterThanOrEqual(before);
      expect(dependencyLastCheck.get({ dependency })).toBeGreaterThanOrEqual(before);
      expect(dependencyCheckFailures.get({ dependency })).toBe(0);
    }
  });

  it("flips Meilisearch to 0 when its client errors, and back to 1 when it recovers", async () => {
    await recordDependencyHealth();
    const lastGood = dependencyLastSuccess.get({ dependency: "meilisearch" })!;
    expect(dependencyUp.get({ dependency: "meilisearch" })).toBe(1);

    meiliHealth.mockRejectedValue(new Error("getaddrinfo ENOTFOUND meilisearch"));
    await new Promise((r) => setTimeout(r, 15));
    const statuses = await recordDependencyHealth();

    expect(statuses.meilisearch).toBe("down");
    expect(dependencyUp.get({ dependency: "meilisearch" })).toBe(0);
    // The others are unaffected.
    expect(dependencyUp.get({ dependency: "postgres" })).toBe(1);
    expect(dependencyUp.get({ dependency: "redis" })).toBe(1);
    // Last success is frozen at the last good probe while the check time moves on.
    expect(dependencyLastSuccess.get({ dependency: "meilisearch" })).toBe(lastGood);
    expect(dependencyLastCheck.get({ dependency: "meilisearch" })).toBeGreaterThan(lastGood);
    expect(dependencyCheckFailures.get({ dependency: "meilisearch" })).toBe(1);

    await recordDependencyHealth();
    expect(dependencyCheckFailures.get({ dependency: "meilisearch" })).toBe(2);
    expect(dependencyLastSuccess.get({ dependency: "meilisearch" })).toBe(lastGood);

    meiliHealth.mockResolvedValue({ status: "available" });
    await recordDependencyHealth();
    expect(dependencyUp.get({ dependency: "meilisearch" })).toBe(1);
    expect(dependencyLastSuccess.get({ dependency: "meilisearch" })).toBeGreaterThan(lastGood);
  });

  it("flips Redis to 0 when its client errors", async () => {
    vi.spyOn(getRedis(), "ping").mockRejectedValue(new Error("ECONNREFUSED"));
    const statuses = await recordDependencyHealth();
    expect(statuses).toEqual({ postgres: "ok", redis: "down", meilisearch: "ok" });
    expect(dependencyUp.get({ dependency: "redis" })).toBe(0);
    expect(dependencyCheckFailures.get({ dependency: "redis" })).toBe(1);
  });

  it("flips Postgres to 0 when the query errors", async () => {
    vi.spyOn(db, "execute").mockRejectedValue(new Error("connection terminated"));
    const statuses = await recordDependencyHealth();
    expect(statuses.postgres).toBe("down");
    expect(dependencyUp.get({ dependency: "postgres" })).toBe(0);
    expect(dependencyUp.get({ dependency: "meilisearch" })).toBe(1);
  });

  // A dependency that was never reachable must still export a last-success
  // series (0), or an alert on its age would have nothing to evaluate.
  it("exports last-success = 0 for a dependency down since start", async () => {
    meiliHealth.mockRejectedValue(new Error("down from the start"));
    await recordDependencyHealth();
    expect(dependencyLastSuccess.get({ dependency: "meilisearch" })).toBe(0);
    expect(registry.render()).toContain(
      'backend_dependency_last_success_timestamp_seconds{dependency="meilisearch"} 0\n',
    );
    expect(registry.render()).toContain('backend_dependency_up{dependency="meilisearch"} 0\n');
  });

  it("reports a hanging dependency as down once the probe budget runs out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    meiliHealth.mockReturnValue(new Promise(() => {}));
    const pending = recordDependencyHealth();
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    const statuses = await pending;
    expect(statuses.meilisearch).toBe("down");
    expect(dependencyUp.get({ dependency: "meilisearch" })).toBe(0);
  });

  it("logs a transition once, not every failed probe", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    meiliHealth.mockRejectedValue(new Error("ENOTFOUND"));
    await recordDependencyHealth();
    await recordDependencyHealth();
    await recordDependencyHealth();
    expect(error.mock.calls.filter((c) => String(c[0]).includes("meilisearch is down"))).toHaveLength(1);

    meiliHealth.mockResolvedValue({ status: "available" });
    await recordDependencyHealth();
    await recordDependencyHealth();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("meilisearch recovered"))).toHaveLength(1);
  });

  it("stays silent while everything is healthy", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await recordDependencyHealth();
    await recordDependencyHealth();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

const ALL_DEPENDENCY_METRICS = [
  dependencyUp,
  dependencyLastSuccess,
  dependencyLastCheck,
  dependencyCheckFailures,
  dependencyCheckDuration,
];

// GET /health is reachable from outside. If it recorded, anyone could inflate
// the failure counter by calling it during an outage, and the gauges would
// reflect whoever called last rather than the sampler's fixed cadence.
describe("GET /health checks without recording", () => {
  let server: FastifyInstance;
  beforeEach(async () => {
    server = await buildTestServer();
  });
  afterEach(async () => {
    await closeTestServer();
  });

  it("checkDependencies reports status and touches no metric", async () => {
    meiliHealth.mockRejectedValue(new Error("ENOTFOUND meilisearch"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await checkDependencies()).toEqual({ postgres: "ok", redis: "ok", meilisearch: "down" });
    for (const m of ALL_DEPENDENCY_METRICS) expect(m.seriesCount()).toBe(0);
    // No transition log either: that belongs to the recording path.
    expect(error).not.toHaveBeenCalled();
  });

  it("a healthy /health call leaves every dependency metric untouched", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    for (const m of ALL_DEPENDENCY_METRICS) expect(m.seriesCount()).toBe(0);
  });

  it("repeated /health calls during an outage do not move the failure counter or the gauges", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The sampler has recorded one failed probe.
    meiliHealth.mockRejectedValue(new Error("ENOTFOUND meilisearch"));
    await recordDependencyHealth();
    const failures = dependencyCheckFailures.get({ dependency: "meilisearch" });
    const lastCheck = dependencyLastCheck.get({ dependency: "meilisearch" });
    const duration = dependencyCheckDuration.get({ dependency: "meilisearch" });
    expect(failures).toBe(1);

    await new Promise((r) => setTimeout(r, 15));
    for (let i = 0; i < 25; i++) {
      const res = await server.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(503);
      expect(res.json().checks.meilisearch).toBe("down");
    }

    expect(dependencyCheckFailures.get({ dependency: "meilisearch" })).toBe(failures);
    expect(dependencyLastCheck.get({ dependency: "meilisearch" })).toBe(lastCheck);
    expect(dependencyCheckDuration.get({ dependency: "meilisearch" })).toBe(duration);
    expect(dependencyUp.get({ dependency: "meilisearch" })).toBe(0);
  });

  it("/health cannot flip a gauge the sampler set: it reports the live state, the gauge keeps the sampled one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await recordDependencyHealth(); // sampled: up
    expect(dependencyUp.get({ dependency: "meilisearch" })).toBe(1);

    meiliHealth.mockRejectedValue(new Error("ENOTFOUND meilisearch"));
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503); // /health itself is truthful right away
    expect(dependencyUp.get({ dependency: "meilisearch" })).toBe(1); // until the next sample
    expect(dependencyCheckFailures.get({ dependency: "meilisearch" })).toBe(0);

    await recordDependencyHealth(); // the sampler's next pass
    expect(dependencyUp.get({ dependency: "meilisearch" })).toBe(0);
  });
});

// A timeout only stops waiting; the probe behind it keeps running. Against a
// dependency that has stopped answering, each new probe would be one more
// pending operation on the shared client.
describe("a hung dependency holds one probe, not one per check", () => {
  it("does not start another probe while the previous one is still pending", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    meiliHealth.mockReturnValue(new Promise(() => {})); // never settles

    for (let pass = 0; pass < 4; pass++) {
      const pending = recordDependencyHealth();
      await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
      expect((await pending).meilisearch).toBe("down");
    }
    // /health during the same outage does not add one either.
    const viaHealth = checkDependencies();
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect((await viaHealth).meilisearch).toBe("down");

    expect(meiliHealth).toHaveBeenCalledTimes(1);
    expect(dependencyCheckFailures.get({ dependency: "meilisearch" })).toBe(4);
  });

  it("probes again once the pending probe settles", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settle!: (v: unknown) => void;
    meiliHealth.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));

    const first = recordDependencyHealth();
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect((await first).meilisearch).toBe("down");

    settle({ status: "available" }); // the old probe finally answers
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();

    expect((await recordDependencyHealth()).meilisearch).toBe("ok");
    expect(meiliHealth).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers share one probe and all get the answer", async () => {
    let settle!: (v: unknown) => void;
    meiliHealth.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
    const callers = [checkDependencies(), checkDependencies(), checkDependencies()];
    settle({ status: "available" });
    for (const status of await Promise.all(callers)) expect(status.meilisearch).toBe("ok");
    expect(meiliHealth).toHaveBeenCalledTimes(1);
  });
});
