/**
 * Dependency gauges: `backend_dependency_up` flips when a dependency's client
 * errors or hangs, and `…_last_success_timestamp_seconds` stops advancing —
 * the signal that would have caught a search engine crash-looping for weeks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getMeilisearchClient } from "../../src/lib/meilisearch.js";
import { getRedis } from "../../src/lib/redis.js";
import { db } from "../../src/db/connection.js";
import { checkDependencies, resetDependencyState, CHECK_TIMEOUT_MS } from "../../src/lib/dependencyHealth.js";
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
    expect(await checkDependencies()).toEqual({ postgres: "ok", redis: "ok", meilisearch: "ok" });
    for (const dependency of ["postgres", "redis", "meilisearch"] as const) {
      expect(dependencyUp.get({ dependency })).toBe(1);
      expect(dependencyLastSuccess.get({ dependency })).toBeGreaterThanOrEqual(before);
      expect(dependencyLastCheck.get({ dependency })).toBeGreaterThanOrEqual(before);
      expect(dependencyCheckFailures.get({ dependency })).toBe(0);
    }
  });

  it("flips Meilisearch to 0 when its client errors, and back to 1 when it recovers", async () => {
    await checkDependencies();
    const lastGood = dependencyLastSuccess.get({ dependency: "meilisearch" })!;
    expect(dependencyUp.get({ dependency: "meilisearch" })).toBe(1);

    meiliHealth.mockRejectedValue(new Error("getaddrinfo ENOTFOUND meilisearch"));
    await new Promise((r) => setTimeout(r, 15));
    const statuses = await checkDependencies();

    expect(statuses.meilisearch).toBe("down");
    expect(dependencyUp.get({ dependency: "meilisearch" })).toBe(0);
    // The others are unaffected.
    expect(dependencyUp.get({ dependency: "postgres" })).toBe(1);
    expect(dependencyUp.get({ dependency: "redis" })).toBe(1);
    // Last success is frozen at the last good probe while the check time moves on.
    expect(dependencyLastSuccess.get({ dependency: "meilisearch" })).toBe(lastGood);
    expect(dependencyLastCheck.get({ dependency: "meilisearch" })).toBeGreaterThan(lastGood);
    expect(dependencyCheckFailures.get({ dependency: "meilisearch" })).toBe(1);

    await checkDependencies();
    expect(dependencyCheckFailures.get({ dependency: "meilisearch" })).toBe(2);
    expect(dependencyLastSuccess.get({ dependency: "meilisearch" })).toBe(lastGood);

    meiliHealth.mockResolvedValue({ status: "available" });
    await checkDependencies();
    expect(dependencyUp.get({ dependency: "meilisearch" })).toBe(1);
    expect(dependencyLastSuccess.get({ dependency: "meilisearch" })).toBeGreaterThan(lastGood);
  });

  it("flips Redis to 0 when its client errors", async () => {
    vi.spyOn(getRedis(), "ping").mockRejectedValue(new Error("ECONNREFUSED"));
    const statuses = await checkDependencies();
    expect(statuses).toEqual({ postgres: "ok", redis: "down", meilisearch: "ok" });
    expect(dependencyUp.get({ dependency: "redis" })).toBe(0);
    expect(dependencyCheckFailures.get({ dependency: "redis" })).toBe(1);
  });

  it("flips Postgres to 0 when the query errors", async () => {
    vi.spyOn(db, "execute").mockRejectedValue(new Error("connection terminated"));
    const statuses = await checkDependencies();
    expect(statuses.postgres).toBe("down");
    expect(dependencyUp.get({ dependency: "postgres" })).toBe(0);
    expect(dependencyUp.get({ dependency: "meilisearch" })).toBe(1);
  });

  // A dependency that was never reachable must still export a last-success
  // series (0), or an alert on its age would have nothing to evaluate.
  it("exports last-success = 0 for a dependency down since start", async () => {
    meiliHealth.mockRejectedValue(new Error("down from the start"));
    await checkDependencies();
    expect(dependencyLastSuccess.get({ dependency: "meilisearch" })).toBe(0);
    expect(registry.render()).toContain(
      'backend_dependency_last_success_timestamp_seconds{dependency="meilisearch"} 0\n',
    );
    expect(registry.render()).toContain('backend_dependency_up{dependency="meilisearch"} 0\n');
  });

  it("reports a hanging dependency as down once the probe budget runs out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    meiliHealth.mockReturnValue(new Promise(() => {}));
    const pending = checkDependencies();
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    const statuses = await pending;
    expect(statuses.meilisearch).toBe("down");
    expect(dependencyUp.get({ dependency: "meilisearch" })).toBe(0);
  });

  it("logs a transition once, not every failed probe", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    meiliHealth.mockRejectedValue(new Error("ENOTFOUND"));
    await checkDependencies();
    await checkDependencies();
    await checkDependencies();
    expect(error.mock.calls.filter((c) => String(c[0]).includes("meilisearch is down"))).toHaveLength(1);

    meiliHealth.mockResolvedValue({ status: "available" });
    await checkDependencies();
    await checkDependencies();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("meilisearch recovered"))).toHaveLength(1);
  });

  it("stays silent while everything is healthy", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await checkDependencies();
    await checkDependencies();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
