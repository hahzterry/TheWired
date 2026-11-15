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
  sampleNotificationQueue,
  sampleOnce,
  sampleTranscodeQueue,
  startMetricsSampler,
} from "../../src/workers/metricsSampler.js";
import {
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
  resetDependencyState();
});

afterEach(() => {
  vi.restoreAllMocks();
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
