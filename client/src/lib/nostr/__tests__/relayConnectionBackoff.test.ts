import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RelayConnection, reservedSlots } from "../relayConnection";
import { StormDetector, computeBackoff, isStruckOut, maxDelayFor, type RelayTier } from "../reconnect";
import { RECONNECT } from "../constants";

/**
 * Dead-relay policy and priority subscriptions, at the single-connection level:
 * strike counting, the backoff schedule per tier, session drop for fan-out
 * relays only, reset on a stable connection and on resetBackoff(), the connect
 * timeout, and the reserved subscription slots a user-initiated request uses.
 */

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closeCalls = 0;

  constructor(public url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closeCalls++;
    this.readyState = MockWebSocket.CLOSED;
  }
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  simulateMessage(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** The connection dropped, or the connect attempt failed. */
  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onerror?.();
    this.onclose?.();
  }
}

let sockets: MockWebSocket[] = [];
/** Fake-clock time at which each socket was created. */
let dialTimes: number[] = [];
let t0 = 0;

beforeEach(() => {
  sockets = [];
  dialTimes = [];
  vi.useFakeTimers();
  t0 = Date.now();
  vi.stubGlobal(
    "WebSocket",
    class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
        dialTimes.push(Date.now() - t0);
      }
    },
  );
  // Math.random() = 0.5 → jitter factor 0: delays are exactly the nominal ones.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createConn(tier?: RelayTier, onStrikeOut?: () => boolean): RelayConnection {
  const conn = new RelayConnection("wss://test.relay", "read+write", new StormDetector());
  conn.setCallbacks({
    ...(tier ? { getTier: () => tier } : {}),
    ...(onStrikeOut ? { onStrikeOut } : {}),
  });
  return conn;
}

const latest = () => sockets[sockets.length - 1];
const reqIds = (ws: MockWebSocket) =>
  ws.sent.map((s) => JSON.parse(s) as unknown[]).filter((m) => m[0] === "REQ").map((m) => m[1] as string);
const closeIds = (ws: MockWebSocket) =>
  ws.sent.map((s) => JSON.parse(s) as unknown[]).filter((m) => m[0] === "CLOSE").map((m) => m[1] as string);

/** Fail the current dial and run the clock up to (and including) the next one. */
function failAndWaitForRedial(maxWaitMs = 10 * 60_000): boolean {
  const before = sockets.length;
  latest().simulateClose();
  for (let waited = 0; waited < maxWaitMs && sockets.length === before; waited += 250) {
    vi.advanceTimersByTime(250);
  }
  return sockets.length > before;
}

describe("reconnect policy helpers", () => {
  it("backs off exponentially from 1 s and caps at the given maximum", () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => computeBackoff(n))).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000]);
    expect(computeBackoff(6)).toBe(60_000); // 64 s capped to MAX_DELAY
    expect(computeBackoff(20)).toBe(60_000);
    expect(computeBackoff(8, RECONNECT.DEAD_MAX_DELAY)).toBe(256_000);
    expect(computeBackoff(9, RECONNECT.DEAD_MAX_DELAY)).toBe(300_000);
    expect(computeBackoff(500, RECONNECT.DEAD_MAX_DELAY)).toBe(300_000); // no overflow
  });

  it("applies ±25% jitter around the nominal delay", () => {
    vi.mocked(Math.random).mockReturnValue(0);
    expect(computeBackoff(2)).toBe(3000); // 4 s − 25%
    vi.mocked(Math.random).mockReturnValue(1);
    expect(computeBackoff(2)).toBe(5000); // 4 s + 25%
    vi.mocked(Math.random).mockReturnValue(0.123);
    const d = computeBackoff(3);
    expect(d).toBeGreaterThanOrEqual(6000);
    expect(d).toBeLessThanOrEqual(10_000);
  });

  it("strikes out at STRIKE_LIMIT", () => {
    expect(RECONNECT.STRIKE_LIMIT).toBe(3);
    expect(isStruckOut(2)).toBe(false);
    expect(isStruckOut(3)).toBe(true);
  });

  it("only a struck-out, non-app relay gets the long cap", () => {
    expect(maxDelayFor("app", 50)).toBe(RECONNECT.MAX_DELAY);
    expect(maxDelayFor("pinned", 2)).toBe(RECONNECT.MAX_DELAY);
    expect(maxDelayFor("pinned", 3)).toBe(RECONNECT.DEAD_MAX_DELAY);
    expect(maxDelayFor("transient", 3)).toBe(RECONNECT.DEAD_MAX_DELAY);
  });
});

describe("RelayConnection — strikes and backoff", () => {
  it("counts each failed connect as a strike", () => {
    const conn = createConn("pinned");
    conn.connect();
    expect(conn.getStrikes()).toBe(0);
    for (let n = 1; n <= 4; n++) {
      expect(failAndWaitForRedial()).toBe(true);
      expect(conn.getStrikes()).toBe(n);
    }
  });

  it("redials on the 1, 2, 4, 8… second schedule", () => {
    const conn = createConn("pinned");
    conn.connect();
    for (let i = 0; i < 6; i++) failAndWaitForRedial();
    // Gaps between consecutive dials (the helper steps the clock in 250 ms).
    const gaps = dialTimes.slice(1).map((t, i) => t - dialTimes[i]);
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000]);
  });

  it("caps the app relay's backoff at MAX_DELAY, however long it has been down", () => {
    const conn = createConn("app");
    conn.connect();
    for (let i = 0; i < 12; i++) expect(failAndWaitForRedial()).toBe(true);
    const gaps = dialTimes.slice(1).map((t, i) => t - dialTimes[i]);
    expect(Math.max(...gaps)).toBe(RECONNECT.MAX_DELAY);
    expect(gaps.slice(-4)).toEqual([60_000, 60_000, 60_000, 60_000]);
  });

  it("lets a struck-out chosen relay back off further, capped at DEAD_MAX_DELAY, and never stops", () => {
    const strikeOut = vi.fn(() => true);
    const conn = createConn("pinned", strikeOut);
    conn.connect();
    for (let i = 0; i < 14; i++) expect(failAndWaitForRedial()).toBe(true);
    const gaps = dialTimes.slice(1).map((t, i) => t - dialTimes[i]);
    expect(gaps.slice(0, 9)).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000]);
    expect(gaps.slice(-3)).toEqual([300_000, 300_000, 300_000]);
    expect(conn.getStrikes()).toBe(14);
    // A chosen relay is never offered up for dropping.
    expect(strikeOut).not.toHaveBeenCalled();
  });

  it("defaults to never dropping when no tier is supplied", () => {
    const conn = createConn();
    conn.connect();
    for (let i = 0; i < 8; i++) expect(failAndWaitForRedial()).toBe(true);
  });

  it("drops a fan-out relay for the session at the third strike", () => {
    const strikeOut = vi.fn(() => true);
    const conn = createConn("transient", strikeOut);
    conn.connect();
    expect(failAndWaitForRedial()).toBe(true); // strike 1 → redial after 1 s
    expect(failAndWaitForRedial()).toBe(true); // strike 2 → redial after 2 s
    expect(strikeOut).not.toHaveBeenCalled();
    expect(failAndWaitForRedial(60 * 60_000)).toBe(false); // strike 3 → nothing for an hour
    expect(strikeOut).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(3);
    expect(dialTimes).toEqual([0, 1000, 3000]);
  });

  it("keeps retrying a fan-out relay when its owner declines the drop (network down)", () => {
    const strikeOut = vi.fn(() => false);
    const conn = createConn("transient", strikeOut);
    conn.connect();
    for (let i = 0; i < 6; i++) expect(failAndWaitForRedial()).toBe(true);
    // Asked again at every strike from the limit on.
    expect(strikeOut).toHaveBeenCalledTimes(4);
  });

  it("resets strikes once a connection has held for STABLE_AFTER", () => {
    const conn = createConn("pinned");
    conn.connect();
    failAndWaitForRedial();
    failAndWaitForRedial();
    expect(conn.getStrikes()).toBe(2);

    latest().simulateOpen();
    vi.advanceTimersByTime(RECONNECT.STABLE_AFTER - 1);
    expect(conn.getStrikes()).toBe(2); // not yet proven
    vi.advanceTimersByTime(1);
    expect(conn.getStrikes()).toBe(0);

    // A drop of that healthy connection is not a strike and retries after 1 s.
    const before = Date.now();
    const count = sockets.length;
    latest().simulateClose();
    expect(conn.getStrikes()).toBe(0);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(count);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(count + 1);
    expect(Date.now() - before).toBe(1000);
  });

  it("counts a socket that opens and closes straight away as a failed connect", () => {
    const strikeOut = vi.fn(() => true);
    const conn = createConn("transient", strikeOut);
    conn.connect();
    // A relay that accepts and immediately hangs up, three times over.
    for (let i = 0; i < 3; i++) {
      latest().simulateOpen();
      vi.advanceTimersByTime(200);
      const before = sockets.length;
      latest().simulateClose();
      vi.advanceTimersByTime(10_000);
      if (i < 2) expect(sockets.length).toBe(before + 1);
    }
    expect(strikeOut).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(3);
  });

  it("abandons a connect that never opens after CONNECT_TIMEOUT and counts it", () => {
    const status: string[] = [];
    const conn = createConn("pinned");
    conn.setCallbacks({ onStatusChange: (_u, s) => status.push(s) });
    conn.connect();
    const first = latest();
    vi.advanceTimersByTime(RECONNECT.CONNECT_TIMEOUT - 1);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(first.closeCalls).toBe(1);
    expect(conn.getStrikes()).toBe(1);
    expect(status).toEqual(["connecting", "error", "disconnected"]);

    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);

    // The abandoned socket coming to life later must not disturb its successor.
    first.simulateOpen();
    first.simulateClose();
    expect(conn.getStrikes()).toBe(1);
    expect(conn.getStatus()).toBe("connecting");
    latest().simulateOpen();
    expect(conn.getStatus()).toBe("connected");
  });

  it("does not let an outside connect() bypass the backoff", () => {
    const conn = createConn("pinned");
    conn.connect();
    failAndWaitForRedial();
    failAndWaitForRedial();
    latest().simulateClose(); // strike 3: next dial in 4 s
    const count = sockets.length;
    for (let i = 0; i < 20; i++) conn.connect(); // callers "making sure" it is connected
    expect(sockets).toHaveLength(count);
    expect(conn.isIdle()).toBe(false);
    vi.advanceTimersByTime(4000);
    expect(sockets).toHaveLength(count + 1);
  });

  it("does not open a second socket while one is connecting or open", () => {
    const conn = createConn("pinned");
    conn.connect();
    conn.connect();
    latest().simulateOpen();
    conn.connect();
    expect(sockets).toHaveLength(1);
  });

  it("resetBackoff clears strikes and hands the dial back to the caller", () => {
    const conn = createConn("pinned");
    conn.connect();
    for (let i = 0; i < 5; i++) failAndWaitForRedial();
    latest().simulateClose(); // strike 6: waiting 32 s
    expect(conn.getStrikes()).toBe(6);
    const count = sockets.length;

    expect(conn.resetBackoff()).toBe(true);
    expect(conn.getStrikes()).toBe(0);
    expect(conn.isIdle()).toBe(true);
    // The pending retry was cancelled: nothing dials until the caller does.
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(count);
    conn.connect();
    expect(sockets).toHaveLength(count + 1);
    // And the schedule starts over.
    const at = Date.now();
    latest().simulateClose();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(count + 2);
    expect(Date.now() - at).toBe(1000);
  });

  it("resetBackoff leaves a connected or connecting socket alone", () => {
    const conn = createConn("pinned");
    conn.connect();
    expect(conn.resetBackoff()).toBe(false); // connecting
    latest().simulateOpen();
    conn.subscribe("s1", [{ kinds: [1] }]);
    expect(conn.resetBackoff()).toBe(false); // connected
    expect(sockets).toHaveLength(1);
    expect(reqIds(latest())).toEqual(["s1"]);
    expect(closeIds(latest())).toEqual([]);
  });

  it("disconnect() cancels every timer (no dial, no strike afterwards)", () => {
    const conn = createConn("pinned");
    conn.connect();
    failAndWaitForRedial();
    conn.disconnect();
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets).toHaveLength(2);
    expect(conn.getStatus()).toBe("disconnected");
  });
});

describe("RelayConnection — reserved slots for user-initiated requests", () => {
  function connected(max: number): { conn: RelayConnection; ws: MockWebSocket } {
    const conn = createConn("app");
    conn.setMaxSubscriptions(max);
    conn.connect();
    latest().simulateOpen();
    return { conn, ws: latest() };
  }

  it("reserves 2 slots on normal caps, 1 on small ones, none on tiny ones", () => {
    expect(reservedSlots(100)).toBe(2);
    expect(reservedSlots(20)).toBe(2);
    expect(reservedSlots(10)).toBe(1);
    expect(reservedSlots(5)).toBe(1);
    expect(reservedSlots(4)).toBe(0);
  });

  it("standing subs stop at cap − reserve", () => {
    const { conn, ws } = connected(10);
    for (let i = 1; i <= 12; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9] }]);
    expect(reqIds(ws)).toHaveLength(9);
    expect(reqIds(ws)).not.toContain("bg-10");
    for (let i = 1; i <= 12; i++) expect(conn.hasSubscription(`bg-${i}`)).toBe(true);
  });

  it("sends a priority request at once while standing subs have the cap saturated", () => {
    const { conn, ws } = connected(100);
    for (let i = 1; i <= 140; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9] }]);
    expect(reqIds(ws)).toHaveLength(98);

    conn.subscribe("page-1", [{ kinds: [1], until: 1000, limit: 30 }], { priority: true });
    expect(reqIds(ws)).toContain("page-1");
    expect(conn.wasReqSent("page-1")).toBe(true);
    expect(conn.wasReqSent("bg-120")).toBe(false);
    // Never more REQs on the wire than the relay allows.
    expect(reqIds(ws)).toHaveLength(99);
    // Nothing was closed to make room.
    expect(closeIds(ws)).toEqual([]);
  });

  it("frees the reserved slot again when the request closes, so every page gets through", () => {
    const { conn, ws } = connected(100);
    for (let i = 1; i <= 140; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9] }]);
    for (let page = 1; page <= 8; page++) {
      conn.subscribe(`page-${page}`, [{ kinds: [1], limit: 30 }], { priority: true });
      expect(reqIds(ws)).toContain(`page-${page}`);
      conn.closeSubscription(`page-${page}`);
    }
    // The freed slot never leaked to a standing sub.
    expect(reqIds(ws).filter((id) => id.startsWith("bg-"))).toHaveLength(98);
  });

  it("queues a priority request ahead of standing subs when even the reserve is taken", () => {
    const { conn, ws } = connected(10); // 9 standing + 1 reserved
    for (let i = 1; i <= 12; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9] }]);
    conn.subscribe("page-1", [{ kinds: [1] }], { priority: true }); // takes the reserved slot
    conn.subscribe("page-2", [{ kinds: [1] }], { priority: true }); // cap is full
    conn.subscribe("page-3", [{ kinds: [1] }], { priority: true });
    expect(reqIds(ws)).toContain("page-1");
    expect(reqIds(ws)).not.toContain("page-2");

    // The next slot to free goes to the waiting priority requests, in order,
    // not to bg-10 which has been waiting longer.
    conn.closeSubscription("page-1");
    expect(reqIds(ws).slice(-1)).toEqual(["page-2"]);
    conn.closeSubscription("page-2");
    expect(reqIds(ws).slice(-1)).toEqual(["page-3"]);
    expect(reqIds(ws)).not.toContain("bg-10");
    // A standing slot freeing still serves the standing queue.
    conn.closeSubscription("page-3");
    conn.closeSubscription("bg-1");
    expect(reqIds(ws).slice(-1)).toEqual(["bg-10"]);
  });

  it("re-sends priority requests first after a reconnect and keeps the reserve", () => {
    const { conn, ws } = connected(10);
    for (let i = 1; i <= 12; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9] }]);
    conn.subscribe("page-1", [{ kinds: [1] }], { priority: true });
    vi.advanceTimersByTime(RECONNECT.STABLE_AFTER);

    ws.simulateClose();
    vi.advanceTimersByTime(1000);
    const ws2 = latest();
    expect(ws2).not.toBe(ws);
    ws2.simulateOpen();
    vi.advanceTimersByTime(2000); // let the staggered resubscribe batches run
    const ids = reqIds(ws2);
    expect(ids[0]).toBe("page-1");
    expect(ids).toHaveLength(10); // 1 priority + 9 standing = the cap
    expect(new Set(ids).size).toBe(10); // each REQ once
  });

  it("re-queues a priority request the relay CLOSED for too-many-subscriptions at the front", () => {
    const { conn, ws } = connected(10);
    for (let i = 1; i <= 12; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9] }]);
    conn.subscribe("page-1", [{ kinds: [1] }], { priority: true });
    ws.simulateMessage(["CLOSED", "page-1", "error: too many subscriptions"]);
    expect(conn.hasSubscription("page-1")).toBe(true);
    conn.closeSubscription("bg-1");
    expect(reqIds(ws).slice(-1)).toEqual(["page-1"]); // ahead of bg-10..12
  });

  it("reports whether a REQ ever left the client", () => {
    const conn = createConn("app");
    conn.connect();
    conn.subscribe("early", [{ kinds: [1] }]);
    expect(conn.wasReqSent("early")).toBe(false); // socket not open yet
    latest().simulateOpen();
    expect(conn.wasReqSent("early")).toBe(true);
    conn.closeSubscription("early");
    expect(conn.wasReqSent("early")).toBe(false);
  });
});

describe("StormDetector", () => {
  it("trips on three live connections dropping within the window, and expires on its own", () => {
    const storm = new StormDetector();
    storm.recordDisconnect();
    storm.recordDisconnect();
    expect(storm.getCooldown()).toBe(0);
    storm.recordDisconnect();
    expect(storm.getCooldown()).toBe(RECONNECT.STORM_COOLDOWN);
    // No further disconnect is needed for the storm to end.
    vi.advanceTimersByTime(RECONNECT.STORM_WINDOW);
    expect(storm.isStorm()).toBe(false);
    expect(storm.getCooldown()).toBe(0);
  });

  it("is not tripped by dials that never opened", () => {
    const storm = new StormDetector();
    const conns = [1, 2, 3, 4].map((n) => new RelayConnection(`wss://dead-${n}.example`, "read", storm));
    for (const c of conns) c.connect();
    for (const ws of sockets) ws.simulateClose();
    expect(storm.isStorm()).toBe(false);
    // So a healthy relay that drops right now still reconnects after 1 s.
    const healthy = new RelayConnection("wss://healthy.example", "read+write", storm);
    healthy.connect();
    const ws = latest();
    ws.simulateOpen();
    vi.advanceTimersByTime(RECONNECT.STABLE_AFTER);
    const count = sockets.filter((s) => s.url === "wss://healthy.example").length;
    ws.simulateClose();
    vi.advanceTimersByTime(1000);
    expect(sockets.filter((s) => s.url === "wss://healthy.example")).toHaveLength(count + 1);
  });

  it("reset() clears a storm", () => {
    const storm = new StormDetector();
    for (let i = 0; i < 3; i++) storm.recordDisconnect();
    storm.reset();
    expect(storm.isStorm()).toBe(false);
  });
});
