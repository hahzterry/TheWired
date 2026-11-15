/**
 * Worker instrumentation, against the real workers: the relay connection
 * manager (connected vs configured, reconnects), event ingestion (counts by
 * kind class, rejections, handler errors), the notification dispatcher (send
 * failures by reason), the locked periodic jobs, and the transcode wrapper.
 *
 * Needs Postgres `thewired_test`; Redis and Meilisearch are the setup mocks.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import * as webPush from "web-push";
import { db } from "../../src/db/connection.js";
import { spaces } from "../../src/db/schema/spaces.js";
import { spaceRelays } from "../../src/db/schema/relays.js";
import { notificationQueue, pushSubscriptions } from "../../src/db/schema/notifications.js";
import { config } from "../../src/config.js";
import { getRedis } from "../../src/lib/redis.js";
import { getMeilisearchClient } from "../../src/lib/meilisearch.js";
import { LUNA } from "../helpers/testUsers.js";
import { pushService } from "../../src/services/pushService.js";
import { processEvent, type IngestContext, type NostrEvent } from "../../src/workers/ingestHandlers.js";
import { dispatchOnce, pollReceiptsOnce, TICKETS_KEY, RECEIPT_DELAY_MS } from "../../src/workers/notificationDispatcher.js";
import { instrumentTranscode } from "../../src/workers/transcodeWorker.js";
import { runWithWorkerLock, startLockedInterval } from "../../src/lib/workerLock.js";
import type { ExpoPushMessage, ExpoReceipt, ExpoSender, ExpoTicket } from "../../src/services/expoPushSender.js";
import {
  registry,
  recordJobFailure,
  ingestEventsRejected,
  ingestEventsTotal,
  ingestHandlerErrors,
  ingestLastEventTimestamp,
  ingestOwnRelayAuthenticated,
  ingestRelayConnects,
  ingestRelayReconnects,
  ingestRelaysConfigured,
  ingestRelaysConnected,
  jobLastSuccess,
  jobLockSkips,
  jobRuns,
  notificationPushesSent,
  notificationRows,
  notificationSendFailures,
  transcodeJobDuration,
  transcodeJobs,
  transcodeJobsActive,
} from "../../src/lib/metrics/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}

// ── relay connection manager ────────────────────────────────────────────────

type Listener = (ev?: unknown) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: Listener) {
    (this.listeners[type] ??= []).push(cb);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.fire("close");
  }
  private fire(type: string, ev?: unknown) {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
  simulateOpen() {
    this.readyState = 1;
    this.fire("open");
  }
  simulateMessage(arr: unknown[]) {
    this.fire("message", { data: JSON.stringify(arr) });
  }
  /** Node's built-in WebSocket on ECONNREFUSED: `error`, no `close`. */
  simulateRefused() {
    this.readyState = 3;
    this.fire("error", { type: "error" });
  }
  /** The peer went away on an established socket. */
  simulateDrop() {
    this.readyState = 3;
    this.fire("close");
  }
}

const EXT = "wss://ext-metrics.example";

describe("relay connection manager metrics", () => {
  let stop: (() => Promise<void>) | null = null;

  beforeAll(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ pubkey: "relaykey" }) })),
    );
  });

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    process.env.INGEST_REFRESH_MS = "40";
    process.env.INGEST_RECONNECT_MS = "30";
    for (const m of [
      ingestRelaysConfigured,
      ingestRelaysConnected,
      ingestRelayConnects,
      ingestRelayReconnects,
      ingestOwnRelayAuthenticated,
    ]) {
      m.reset();
    }
  });

  afterEach(async () => {
    await stop?.();
    stop = null;
    delete process.env.INGEST_REFRESH_MS;
    delete process.env.INGEST_RECONNECT_MS;
  });

  async function start() {
    const { startRelayIngester } = await import("../../src/workers/relayConnectionManager.js");
    const handle = startRelayIngester({ dialGuard: async (url) => ({ ok: true, url }) });
    stop = handle.stop;
  }
  const sockets = (url: string) => MockWebSocket.instances.filter((w) => w.url === url);
  async function latest(url: string, n = 1): Promise<MockWebSocket> {
    await until(() => sockets(url).length >= n);
    return sockets(url)[n - 1];
  }

  it("shows the own relay configured-but-not-connected until the socket opens", async () => {
    await start();
    const own = await latest(config.relayUrl);
    expect(ingestRelaysConfigured.get({ scope: "own" })).toBe(1);
    expect(ingestRelaysConnected.get({ scope: "own" })).toBe(0);

    own.simulateOpen();
    await sleep(10);
    expect(ingestRelaysConnected.get({ scope: "own" })).toBe(1);
    expect(ingestRelayConnects.get({ scope: "own" })).toBe(1);
    expect(ingestRelayReconnects.get({ scope: "own" })).toBe(0);
  });

  it("drops connected to 0 and counts a reconnect when the socket goes away, then recovers", async () => {
    await start();
    const first = await latest(config.relayUrl);
    first.simulateOpen();
    await sleep(10);

    first.simulateDrop();
    expect(ingestRelaysConnected.get({ scope: "own" })).toBe(0);
    expect(ingestRelaysConfigured.get({ scope: "own" })).toBe(1); // still meant to be connected
    expect(ingestRelayReconnects.get({ scope: "own" })).toBe(1);

    const second = await latest(config.relayUrl, 2);
    second.simulateOpen();
    await sleep(10);
    expect(ingestRelaysConnected.get({ scope: "own" })).toBe(1);
    expect(ingestRelayConnects.get({ scope: "own" })).toBe(2);
  });

  // The relay restarting: every retry is refused. The gauge must sit at 0
  // and the reconnect counter must keep climbing — that pair is the alert.
  it("counts every refused retry while the relay is down", async () => {
    await start();
    (await latest(config.relayUrl)).simulateRefused();
    (await latest(config.relayUrl, 2)).simulateRefused();
    await latest(config.relayUrl, 3);
    expect(ingestRelaysConnected.get({ scope: "own" })).toBe(0);
    expect(ingestRelayReconnects.get({ scope: "own" })).toBe(2);
    expect(ingestRelayConnects.get({ scope: "own" })).toBe(0);
  });

  it("tracks external relays separately, by scope and never by URL", async () => {
    await db.insert(spaces).values({
      id: "metrics-space",
      name: "metrics-space",
      hostRelay: EXT,
      createdAt: Date.now(),
      ingestionTier: "discovery",
    });
    await db.insert(spaceRelays).values({ relayUrl: EXT, spaceId: "metrics-space", status: "approved", registeredBy: "creator" });

    await start();
    const ext = await latest(EXT);
    expect(ingestRelaysConfigured.get({ scope: "external" })).toBe(1);
    expect(ingestRelaysConnected.get({ scope: "external" })).toBe(0);

    ext.simulateOpen();
    await sleep(10);
    expect(ingestRelaysConnected.get({ scope: "external" })).toBe(1);
    expect(ingestRelaysConnected.get({ scope: "own" })).toBe(0); // own never opened in this test

    const out = registry.render();
    expect(out).not.toContain("ext-metrics.example");
    expect(out).not.toContain(config.relayUrl);
    expect(out).not.toContain("metrics-space");

    // Unregistering the relay removes it from "configured" too.
    await db.delete(spaceRelays);
    await until(() => ingestRelaysConfigured.get({ scope: "external" }) === 0);
    expect(ingestRelaysConnected.get({ scope: "external" })).toBe(0);
  });

  it("zeroes the gauges on stop", async () => {
    await start();
    (await latest(config.relayUrl)).simulateOpen();
    await sleep(10);
    await stop?.();
    stop = null;
    expect(ingestRelaysConfigured.get({ scope: "own" })).toBe(0);
    expect(ingestRelaysConnected.get({ scope: "own" })).toBe(0);
  });
});

// ── event ingestion ─────────────────────────────────────────────────────────

const ownCtx: IngestContext = { relayUrl: "ws://own", isOwnRelay: true, allowedSpaceIds: null };

function signed(kind: number, tags: string[][] = [], content = "hello"): NostrEvent {
  return finalizeEvent(
    { kind, created_at: Math.floor(Date.now() / 1000), tags, content },
    generateSecretKey(),
  ) as unknown as NostrEvent;
}

describe("ingest handler metrics", () => {
  beforeEach(() => {
    for (const m of [ingestEventsTotal, ingestEventsRejected, ingestHandlerErrors, ingestLastEventTimestamp]) m.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    const index = getMeilisearchClient().index("events") as unknown as { addDocuments: ReturnType<typeof vi.fn> };
    index.addDocuments.mockReset();
    index.addDocuments.mockImplementation(() =>
      Object.assign(Promise.resolve({ taskUid: 0 }), { waitTask: vi.fn().mockResolvedValue({ status: "succeeded" }) }),
    );
  });

  it("counts a verified event by kind class and stamps the last-event time", async () => {
    const before = Date.now() / 1000;
    await processEvent(signed(1), ownCtx);
    await processEvent(signed(1), ownCtx);
    await processEvent(signed(30023, [["d", "post"]]), ownCtx);
    expect(ingestEventsTotal.get({ kind_class: "note", source: "own" })).toBe(2);
    expect(ingestEventsTotal.get({ kind_class: "article", source: "own" })).toBe(1);
    expect(ingestLastEventTimestamp.get({ source: "own" })).toBeGreaterThanOrEqual(before);
    expect(ingestEventsRejected.get({ reason: "invalid_signature" })).toBe(0);
  });

  it("counts an event from an external relay under source=external", async () => {
    await db.insert(spaces).values({ id: "ext-space", name: "ext-space", hostRelay: "wss://ext", createdAt: Date.now() });
    const ext: IngestContext = { relayUrl: "wss://ext", isOwnRelay: false, allowedSpaceIds: new Set(["ext-space"]) };
    await processEvent(signed(9, [["h", "ext-space"]]), ext);
    expect(ingestEventsTotal.get({ kind_class: "chat", source: "external" })).toBe(1);
    expect(ingestEventsTotal.get({ kind_class: "chat", source: "own" })).toBe(0);
  });

  it("counts a forged event as rejected, not ingested", async () => {
    const forged = { ...signed(1), content: "tampered after signing" };
    await processEvent(forged, ownCtx);
    expect(ingestEventsRejected.get({ reason: "invalid_signature" })).toBe(1);
    expect(ingestEventsTotal.get({ kind_class: "note", source: "own" })).toBe(0);
    expect(ingestLastEventTimestamp.get({ source: "own" })).toBeUndefined();
  });

  // Meilisearch down: the search write throws out of processEvent. The event
  // was received (counted) and the failure is counted against its kind.
  it("counts a handler error when the search index write fails, and rethrows", async () => {
    const index = getMeilisearchClient().index("events") as unknown as { addDocuments: ReturnType<typeof vi.fn> };
    index.addDocuments.mockImplementation(() => Promise.reject(new Error("getaddrinfo ENOTFOUND meilisearch")));

    await expect(processEvent(signed(1), ownCtx)).rejects.toThrow(/ENOTFOUND/);
    expect(ingestEventsTotal.get({ kind_class: "note", source: "own" })).toBe(1);
    expect(ingestHandlerErrors.get({ kind_class: "note", stage: "process" })).toBe(1);
  });

  it("never puts a pubkey or event id in a label", async () => {
    const event = signed(1);
    await processEvent(event, ownCtx);
    const out = registry.render();
    expect(out).not.toContain(event.pubkey);
    expect(out).not.toContain(event.id);
  });
});

// ── notification dispatcher ─────────────────────────────────────────────────

function sender(ticketFor: (m: ExpoPushMessage) => ExpoTicket): ExpoSender {
  return {
    send: vi.fn(async (messages: ExpoPushMessage[]) => messages.map(ticketFor)),
    receipts: vi.fn(async () => ({})),
  };
}

async function queueRow() {
  const id = randomUUID();
  await db.insert(notificationQueue).values({
    id,
    pubkey: LUNA.pubkey,
    type: "reply",
    title: "reply",
    body: "b",
    url: "soot://note/x",
    collapseKey: `activity:${LUNA.pubkey}:${id}`,
    createdAt: new Date(),
  });
  return id;
}

describe("notification dispatcher metrics", () => {
  beforeEach(async () => {
    for (const m of [notificationPushesSent, notificationSendFailures, notificationRows]) m.reset();
    const keys = await getRedis().keys("notif:*");
    if (keys.length > 0) await getRedis().del(...keys);
  });

  it("counts an accepted Expo push and the settled row", async () => {
    await pushService.registerDevice({ pubkey: LUNA.pubkey, provider: "expo", token: "ExponentPushToken[m1]", platform: "ios" });
    await queueRow();
    await dispatchOnce({ sender: sender(() => ({ status: "ok", id: randomUUID() })) });
    expect(notificationPushesSent.get({ channel: "expo" })).toBe(1);
    expect(notificationRows.get({ outcome: "sent" })).toBe(1);
    expect(notificationSendFailures.seriesCount()).toBe(0);
  });

  it("counts a failed Expo request and the retried row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await pushService.registerDevice({ pubkey: LUNA.pubkey, provider: "expo", token: "ExponentPushToken[m2]", platform: "ios" });
    await queueRow();
    const failing: ExpoSender = {
      send: vi.fn(async () => {
        throw new Error("expo 503");
      }),
      receipts: vi.fn(async () => ({})),
    };
    await dispatchOnce({ sender: failing });
    expect(notificationSendFailures.get({ channel: "expo", reason: "request_failed" })).toBe(1);
    expect(notificationRows.get({ outcome: "retried" })).toBe(1);
    expect(notificationRows.get({ outcome: "sent" })).toBe(0);
    expect(notificationPushesSent.get({ channel: "expo" })).toBe(0);
    vi.restoreAllMocks();
  });

  it("distinguishes a dead token from a ticket error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await pushService.registerDevice({ pubkey: LUNA.pubkey, provider: "expo", token: "ExponentPushToken[dead]", platform: "ios" });
    await queueRow();
    await dispatchOnce({
      sender: sender(() => ({ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } })),
    });
    expect(notificationSendFailures.get({ channel: "expo", reason: "device_not_registered" })).toBe(1);

    await pushService.registerDevice({ pubkey: LUNA.pubkey, provider: "expo", token: "ExponentPushToken[bad]", platform: "ios" });
    await queueRow();
    await dispatchOnce({
      sender: sender(() => ({ status: "error", message: "nope", details: { error: "InvalidCredentials" } })),
    });
    expect(notificationSendFailures.get({ channel: "expo", reason: "ticket_error" })).toBe(1);
    // The provider's own error string is not a label value.
    expect(registry.render()).not.toContain("InvalidCredentials");
    vi.restoreAllMocks();
  });

  it("counts web-push sends, failures and gone subscriptions", async () => {
    const saved = { pub: config.vapidPublicKey, priv: config.vapidPrivateKey };
    (config as { vapidPublicKey: string }).vapidPublicKey = "test-public";
    (config as { vapidPrivateKey: string }).vapidPrivateKey = "test-private";
    const webPushSend = vi.mocked(webPush.sendNotification);
    try {
      const subscribe = () =>
        db.insert(pushSubscriptions).values({
          id: randomUUID(),
          pubkey: LUNA.pubkey,
          endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
          p256dh: "p256dh",
          auth: "auth",
        });
      const none = sender(() => ({ status: "ok", id: randomUUID() }));

      await subscribe();
      await queueRow();
      await dispatchOnce({ sender: none });
      expect(notificationPushesSent.get({ channel: "webpush" })).toBe(1);

      await db.delete(notificationQueue);
      await queueRow();
      webPushSend.mockRejectedValueOnce(Object.assign(new Error("boom"), { statusCode: 500 }));
      await dispatchOnce({ sender: none });
      expect(notificationSendFailures.get({ channel: "webpush", reason: "send_error" })).toBe(1);

      await db.delete(notificationQueue);
      await queueRow();
      webPushSend.mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }));
      await dispatchOnce({ sender: none });
      expect(notificationSendFailures.get({ channel: "webpush", reason: "subscription_gone" })).toBe(1);
    } finally {
      (config as { vapidPublicKey: string }).vapidPublicKey = saved.pub;
      (config as { vapidPrivateKey: string }).vapidPrivateKey = saved.priv;
      webPushSend.mockReset();
      webPushSend.mockResolvedValue({ statusCode: 201 } as never);
    }
  });

  it("counts an expired row", async () => {
    await pushService.registerDevice({ pubkey: LUNA.pubkey, provider: "expo", token: "ExponentPushToken[m3]", platform: "ios" });
    await db.insert(notificationQueue).values({
      id: randomUUID(),
      pubkey: LUNA.pubkey,
      type: "reply",
      title: "old",
      body: "b",
      createdAt: new Date(Date.now() - 24 * 3600 * 1000),
    });
    await dispatchOnce({ sender: sender(() => ({ status: "ok", id: randomUUID() })) });
    expect(notificationRows.get({ outcome: "expired" })).toBe(1);
    expect(notificationPushesSent.get({ channel: "expo" })).toBe(0);
  });

  it("counts receipt-stage failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const at = Date.now() - RECEIPT_DELAY_MS - 1000;
    await getRedis().lpush(
      TICKETS_KEY,
      JSON.stringify({ id: "t1", token: "ExponentPushToken[r1]", pubkey: LUNA.pubkey, at }),
      JSON.stringify({ id: "t2", token: "ExponentPushToken[r2]", pubkey: LUNA.pubkey, at }),
    );
    const receipts: ExpoSender = {
      send: vi.fn(async () => []),
      receipts: vi.fn(
        async (): Promise<Record<string, ExpoReceipt>> => ({
          t1: { status: "error", message: "apns said no", details: { error: "MessageRateExceeded" } },
          t2: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
        }),
      ),
    };
    await pollReceiptsOnce({ sender: receipts });
    expect(notificationSendFailures.get({ channel: "expo", reason: "receipt_error" })).toBe(1);
    expect(notificationSendFailures.get({ channel: "expo", reason: "device_not_registered" })).toBe(1);
    expect(registry.render()).not.toContain("MessageRateExceeded");

    await getRedis().lpush(TICKETS_KEY, JSON.stringify({ id: "t3", token: "x", pubkey: LUNA.pubkey, at }));
    const down: ExpoSender = {
      send: vi.fn(async () => []),
      receipts: vi.fn(async () => {
        throw new Error("expo down");
      }),
    };
    await pollReceiptsOnce({ sender: down });
    expect(notificationSendFailures.get({ channel: "expo", reason: "receipts_request_failed" })).toBe(1);
    vi.restoreAllMocks();
  });

  it("never puts the recipient in a label", async () => {
    await pushService.registerDevice({ pubkey: LUNA.pubkey, provider: "expo", token: "ExponentPushToken[m4]", platform: "ios" });
    await queueRow();
    await dispatchOnce({ sender: sender(() => ({ status: "ok", id: randomUUID() })) });
    const out = registry.render();
    expect(out).not.toContain(LUNA.pubkey);
    expect(out).not.toContain("ExponentPushToken");
  });
});

// ── periodic jobs ───────────────────────────────────────────────────────────

describe("periodic job metrics (worker lock)", () => {
  beforeEach(async () => {
    for (const m of [jobRuns, jobLastSuccess, jobLockSkips]) m.reset();
    await getRedis().flushall();
  });

  it("records a locked run's success and last-success time", async () => {
    const before = Date.now() / 1000;
    expect(await runWithWorkerLock("metrics-job", 5000, async () => {})).toBe(true);
    expect(jobRuns.get({ job: "metrics-job", result: "success" })).toBe(1);
    expect(jobLastSuccess.get({ job: "metrics-job" })).toBeGreaterThanOrEqual(before);
  });

  it("records a throwing run as a failure and still releases the lock", async () => {
    await expect(
      runWithWorkerLock("metrics-job", 5000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(jobRuns.get({ job: "metrics-job", result: "failure" })).toBe(1);
    expect(jobLastSuccess.get({ job: "metrics-job" })).toBeUndefined();
    expect(await getRedis().get("worker:lock:metrics-job")).toBeNull();
  });

  it("counts a tick skipped because the lock is held, and does not count it as a run", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = runWithWorkerLock("contended-job", 5000, () => held);
    await sleep(10);
    expect(await runWithWorkerLock("contended-job", 5000, async () => {})).toBe(false);
    expect(jobLockSkips.get({ job: "contended-job" })).toBe(1);
    release();
    await first;
    expect(jobRuns.get({ job: "contended-job", result: "success" })).toBe(1);
  });

  it("still records the run when Redis is unreachable and the job runs unguarded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(getRedis(), "set").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await runWithWorkerLock("unguarded-job", 5000, async () => {})).toBe(true);
    expect(jobRuns.get({ job: "unguarded-job", result: "success" })).toBe(1);
    vi.restoreAllMocks();
  });

  // The shape every periodic computer has: catch, log, carry on.
  it("a computer that swallows its error shows up as a failed run with a stale last-success", async () => {
    let fail = false;
    const job = startLockedInterval({
      name: "swallowing-computer",
      intervalMs: 25,
      task: async () => {
        try {
          if (fail) throw new Error("meilisearch unreachable");
        } catch {
          recordJobFailure("swallowing-computer");
        }
      },
    });
    try {
      await until(() => jobRuns.get({ job: "swallowing-computer", result: "success" }) >= 2);
      fail = true;
      await sleep(40);
      const frozen = jobLastSuccess.get({ job: "swallowing-computer" });
      await until(() => jobRuns.get({ job: "swallowing-computer", result: "failure" }) >= 2);
      expect(jobLastSuccess.get({ job: "swallowing-computer" })).toBe(frozen);
    } finally {
      job.stop();
    }
  });
});

// ── transcode worker ────────────────────────────────────────────────────────

describe("transcode metrics", () => {
  beforeEach(() => {
    for (const m of [transcodeJobs, transcodeJobDuration, transcodeJobsActive]) m.reset();
  });

  it("tracks an active job, then its completion and duration", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const running = instrumentTranscode(() => gate);
    expect(transcodeJobsActive.get()).toBe(1);
    await sleep(20);
    release();
    await running;
    expect(transcodeJobsActive.get()).toBe(0);
    expect(transcodeJobs.get({ result: "completed" })).toBe(1);
    const observed = transcodeJobDuration.get({ result: "completed" });
    expect(observed.count).toBe(1);
    expect(observed.sum).toBeGreaterThanOrEqual(0.015);
  });

  it("counts a failed job, rethrows, and leaves no job marked active", async () => {
    await expect(
      instrumentTranscode(async () => {
        throw new Error("ffmpeg exited 1");
      }),
    ).rejects.toThrow("ffmpeg exited 1");
    expect(transcodeJobs.get({ result: "failed" })).toBe(1);
    expect(transcodeJobs.get({ result: "completed" })).toBe(0);
    expect(transcodeJobsActive.get()).toBe(0);
  });
});
