/**
 * The sampler behind the pull-style gauges: push-queue backlog read from the
 * table, the transcode queue only when transcoding is on, and one failing
 * part never blocking the others.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../../src/db/connection.js";
import { notificationQueue } from "../../src/db/schema/notifications.js";
import { LUNA } from "../helpers/testUsers.js";
import { config } from "../../src/config.js";
import { getMeilisearchClient } from "../../src/lib/meilisearch.js";
import { resetDependencyState } from "../../src/lib/dependencyHealth.js";
import {
  resetSamplerState,
  SAMPLE_TIMEOUT_MS,
  sampleNotificationQueue,
  sampleOnce,
  sampleTranscodeQueue,
  startMetricsSampler,
} from "../../src/workers/metricsSampler.js";
import {
  dependencyCheckFailures,
  dependencyUp,
  notificationQueueDepth,
  notificationQueueOldestAge,
  transcodeQueueJobs,
} from "../../src/lib/metrics/index.js";

async function queueRow(over: Partial<typeof notificationQueue.$inferInsert> = {}) {
  await db.insert(notificationQueue).values({
    id: randomUUID(),
    pubkey: LUNA.pubkey,
    type: "reply",
    title: "t",
    body: "b",
    createdAt: new Date(),
    ...over,
  });
}

beforeEach(() => {
  notificationQueueDepth.reset();
  notificationQueueOldestAge.reset();
  transcodeQueueJobs.reset();
  dependencyUp.reset();
  dependencyCheckFailures.reset();
  resetDependencyState();
  resetSamplerState();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  const health = getMeilisearchClient().health as ReturnType<typeof vi.fn>;
  health.mockReset();
  health.mockResolvedValue({ status: "available" });
});

describe("notification queue gauges", () => {
  it("is zero for an empty queue", async () => {
    await sampleNotificationQueue();
    expect(notificationQueueDepth.get()).toBe(0);
    expect(notificationQueueOldestAge.get()).toBe(0);
  });

  it("counts unsent rows only and reports the oldest one's age", async () => {
    await queueRow({ createdAt: new Date(Date.now() - 120_000) });
    await queueRow({ createdAt: new Date(Date.now() - 30_000) });
    await queueRow();
    await queueRow({ sent: true, createdAt: new Date(Date.now() - 3_600_000) }); // already settled

    await sampleNotificationQueue();
    expect(notificationQueueDepth.get()).toBe(3);
    const age = notificationQueueOldestAge.get()!;
    expect(age).toBeGreaterThan(115);
    expect(age).toBeLessThan(180);
  });

  it("falls back to zero as the queue drains", async () => {
    await queueRow();
    await sampleNotificationQueue();
    expect(notificationQueueDepth.get()).toBe(1);

    await db.update(notificationQueue).set({ sent: true });
    await sampleNotificationQueue();
    expect(notificationQueueDepth.get()).toBe(0);
    expect(notificationQueueOldestAge.get()).toBe(0);
  });

  it("rejects (leaving the last value) when the database errors", async () => {
    await queueRow();
    await sampleNotificationQueue();
    vi.spyOn(db, "execute").mockRejectedValue(new Error("connection terminated"));
    await expect(sampleNotificationQueue()).rejects.toThrow();
    expect(notificationQueueDepth.get()).toBe(1);
  });
});

describe("transcode queue gauges", () => {
  it("is not sampled when transcoding is off (no queue connection opened)", async () => {
    expect(config.transcodeEnqueue || config.transcodeWorker).toBe(false);
    await sampleTranscodeQueue();
    expect(transcodeQueueJobs.seriesCount()).toBe(0);
  });
});

describe("sampleOnce", () => {
  it("refreshes dependency and queue gauges together", async () => {
    await queueRow();
    await sampleOnce();
    expect(dependencyUp.get({ dependency: "postgres" })).toBe(1);
    expect(dependencyUp.get({ dependency: "meilisearch" })).toBe(1);
    expect(notificationQueueDepth.get()).toBe(1);
  });

  // The Meilisearch incident, in miniature: the engine is gone, the sampler
  // says so, and everything else keeps being sampled.
  it("a dead dependency is reported without stopping the other samples", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    (getMeilisearchClient().health as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOTFOUND meilisearch"));
    await queueRow();
    await queueRow();
    await expect(sampleOnce()).resolves.toBeUndefined();
    expect(dependencyUp.get({ dependency: "meilisearch" })).toBe(0);
    expect(dependencyUp.get({ dependency: "postgres" })).toBe(1);
    expect(notificationQueueDepth.get()).toBe(2);
  });

  it("never rejects, even with the database down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "execute").mockRejectedValue(new Error("connection terminated"));
    await expect(sampleOnce()).resolves.toBeUndefined();
    expect(dependencyUp.get({ dependency: "postgres" })).toBe(0);
  });
});

describe("startMetricsSampler", () => {
  it("samples immediately and again on its interval, and stops", async () => {
    const health = getMeilisearchClient().health as ReturnType<typeof vi.fn>;
    health.mockClear();
    const sampler = startMetricsSampler(40);
    try {
      const deadline = Date.now() + 3000;
      while (health.mock.calls.length < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(health.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      sampler.stop();
    }
    await new Promise((r) => setTimeout(r, 60)); // let an in-flight pass finish
    const settled = health.mock.calls.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(health.mock.calls.length).toBe(settled);
  });
});

// Giving up on a sample does not cancel its query. With a database that has
// stopped answering, a sampler that issued a fresh query every interval would
// leave one more pending on the shared pool each time.
describe("samples do not overlap", () => {
  /** Make the queue-depth query (and only it) hang; returns how many were issued. */
  function hangQueueQuery() {
    const real = db.execute.bind(db);
    let release!: (rows: unknown) => void;
    const hung = new Promise((resolve) => (release = resolve));
    let issued = 0;
    const isQueueQuery = (query: unknown) => JSON.stringify(query).includes("notification_queue");
    vi.spyOn(db, "execute").mockImplementation(((query: unknown) => {
      if (!isQueueQuery(query)) return real(query as never);
      issued += 1;
      return hung;
    }) as never);
    return { issued: () => issued, release };
  }

  it("a second sample while the first query is pending issues no new query", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hung = hangQueueQuery();

    for (let pass = 0; pass < 5; pass++) {
      const sample = sampleNotificationQueue();
      const settled = expect(sample).rejects.toThrow("timeout");
      await vi.advanceTimersByTimeAsync(SAMPLE_TIMEOUT_MS);
      await settled;
    }
    expect(hung.issued()).toBe(1);
  });

  it("samples again once the pending query settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hung = hangQueueQuery();

    const first = sampleNotificationQueue();
    const settled = expect(first).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(SAMPLE_TIMEOUT_MS);
    await settled;

    hung.release([{ depth: 0, oldest_age: 0 }]); // the old query finally returns
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    vi.restoreAllMocks();

    await queueRow();
    await sampleNotificationQueue();
    expect(notificationQueueDepth.get()).toBe(1);
  });

  // The running sampler, over many intervals, against a hung queue query.
  it("the sampler keeps ticking without stacking queries behind a hung one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hung = hangQueueQuery();
    const health = getMeilisearchClient().health as ReturnType<typeof vi.fn>;
    health.mockClear();

    const sampler = startMetricsSampler(20);
    try {
      await new Promise((r) => setTimeout(r, 400)); // ~20 intervals
    } finally {
      sampler.stop();
    }
    // One queue query in total, however many ticks fired.
    expect(hung.issued()).toBe(1);
    // And a pass never starts while the previous pass is still running: the
    // first pass is still waiting on the hung query, so nothing was re-probed.
    expect(health).toHaveBeenCalledTimes(1);
  });

  it("a pass that finishes lets the next tick run", async () => {
    const health = getMeilisearchClient().health as ReturnType<typeof vi.fn>;
    health.mockClear();
    const sampler = startMetricsSampler(20);
    try {
      const deadline = Date.now() + 3000;
      while (health.mock.calls.length < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    } finally {
      sampler.stop();
    }
    expect(health.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
