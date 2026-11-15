import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RelayConnection } from "../relayConnection";
import { StormDetector, computeBackoff, isStruckOut, type RelayTier } from "../reconnect";
import { RECONNECT } from "../constants";

/**
 * Dead-relay policy and priority subscriptions, at the single-connection level:
 * strike counting, the backoff schedule, session drop for fan-out relays only,
 * reset on a stable connection and on resetBackoff(), the connect timeout, the
 * rate-limited kick for a relay the app asks for again, and how a
 * user-initiated request gets a slot on a relay whose cap is full.
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
    expect(computeBackoff(5000)).toBe(60_000); // no overflow
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

  it("has one backoff cap, the 60 s it always was", () => {
    expect(RECONNECT.MAX_DELAY).toBe(60_000);
    expect("DEAD_MAX_DELAY" in RECONNECT).toBe(false);
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

  // Regression: a dead chosen relay briefly backed off up to 5 minutes, so a
  // space host that was down for two minutes stayed unreachable for four more.
  it("keeps a struck-out chosen relay on the 60 s cap, and never stops retrying it", () => {
    const strikeOut = vi.fn(() => true);
    const conn = createConn("pinned", strikeOut);
    conn.connect();
    for (let i = 0; i < 14; i++) expect(failAndWaitForRedial()).toBe(true);
    const gaps = dialTimes.slice(1).map((t, i) => t - dialTimes[i]);
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, ...Array(8).fill(60_000)]);
    expect(conn.getStrikes()).toBe(14);
    // A chosen relay is never offered up for dropping.
    expect(strikeOut).not.toHaveBeenCalled();
  });

  it("with the worst jitter a relay that comes back is retried within 75 s", () => {
    vi.mocked(Math.random).mockReturnValue(1); // +25% on every delay
    const conn = createConn("pinned");
    conn.connect();
    for (let i = 0; i < 12; i++) failAndWaitForRedial();
    const gaps = dialTimes.slice(1).map((t, i) => t - dialTimes[i]);
    expect(Math.max(...gaps)).toBe(75_000);
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

  describe("kick — the app asks again for a relay that is backing off", () => {
    /** A relay that failed 5 times and now waits 16 s for its next dial. */
    function backingOff(): RelayConnection {
      const conn = createConn("pinned");
      conn.connect();
      for (let i = 0; i < 4; i++) failAndWaitForRedial();
      latest().simulateClose();
      return conn;
    }

    it("dials at once instead of waiting out the backoff", () => {
      const conn = backingOff();
      const count = sockets.length;
      vi.advanceTimersByTime(6000); // the relay has come back meanwhile
      expect(sockets).toHaveLength(count);
      expect(conn.kick()).toBe(true);
      expect(sockets).toHaveLength(count + 1);
      latest().simulateOpen();
      expect(conn.getStatus()).toBe("connected");
    });

    it("is rate-limited: no second dial within KICK_INTERVAL of the last one", () => {
      const conn = backingOff();
      const count = sockets.length;
      // The scheduled dial failed a moment ago: a kick right now would hammer.
      expect(conn.kick()).toBe(false);
      vi.advanceTimersByTime(RECONNECT.KICK_INTERVAL - 1);
      expect(conn.kick()).toBe(false);
      expect(sockets).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(conn.kick()).toBe(true);
      expect(sockets).toHaveLength(count + 1);

      // That dial fails too: kicks are refused for another KICK_INTERVAL.
      latest().simulateClose();
      for (let i = 0; i < 50; i++) conn.kick();
      expect(sockets).toHaveLength(count + 1);
      vi.advanceTimersByTime(RECONNECT.KICK_INTERVAL);
      expect(conn.kick()).toBe(true);
      expect(sockets).toHaveLength(count + 2);
    });

    it("a dead relay kicked as hard as possible is dialed at most once per KICK_INTERVAL", () => {
      const conn = backingOff();
      const count = sockets.length;
      const start = Date.now();
      // Kick every 100 ms for a minute; every dial fails immediately.
      for (let t = 0; t < 600; t++) {
        vi.advanceTimersByTime(100);
        conn.kick();
        if (latest().readyState === MockWebSocket.CONNECTING) latest().simulateClose();
      }
      const dials = sockets.length - count;
      const elapsed = Date.now() - start;
      expect(dials).toBeLessThanOrEqual(Math.ceil(elapsed / RECONNECT.KICK_INTERVAL));
      expect(dials).toBeGreaterThan(0);
    });

    it("a failed kick counts as a strike and the backoff carries on from where it was", () => {
      const conn = backingOff(); // 5 strikes, 16 s scheduled
      vi.advanceTimersByTime(RECONNECT.KICK_INTERVAL);
      conn.kick();
      const at = Date.now();
      const count = sockets.length;
      latest().simulateClose();
      expect(conn.getStrikes()).toBe(6);
      // The next step of the same schedule (32 s): the kick neither reset the
      // backoff nor left the old 16 s timer running.
      vi.advanceTimersByTime(31_999);
      expect(sockets).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(count + 1);
      expect(Date.now() - at).toBe(32_000);
    });

    it("does nothing while a socket is connecting or open, or before the first dial", () => {
      const conn = createConn("pinned");
      expect(conn.kick(0)).toBe(false); // never dialed: connect() is the way in
      conn.connect();
      expect(conn.kick(0)).toBe(false);
      latest().simulateOpen();
      expect(conn.kick(0)).toBe(false);
      expect(sockets).toHaveLength(1);
    });
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

describe("RelayConnection — a user-initiated request on a relay whose cap is full", () => {
  function connected(max: number): { conn: RelayConnection; ws: MockWebSocket } {
    const conn = createConn("app");
    conn.setMaxSubscriptions(max);
    conn.connect();
    latest().simulateOpen();
    return { conn, ws: latest() };
  }
  const frameLog = (ws: MockWebSocket) =>
    ws.sent.map((s) => JSON.parse(s) as unknown[]).map((m) => `${m[0]} ${m[1]}`);

  // Regression: two slots used to be held back from standing subs, so an
  // account at the cap had two background subs deferred for good.
  it("standing subs get the relay's full cap", () => {
    const { conn, ws } = connected(100);
    for (let i = 1; i <= 100; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9] }]);
    expect(reqIds(ws)).toHaveLength(100);
    expect(reqIds(ws)).toContain("bg-99");
    expect(reqIds(ws)).toContain("bg-100");
    for (const max of [3, 10, 20]) {
      const c = connected(max);
      for (let i = 1; i <= max + 2; i++) c.conn.subscribe(`s-${i}`, [{ kinds: [9] }]);
      expect(reqIds(c.ws)).toHaveLength(max);
    }
  });

  it("uses a free slot when there is one, closing nothing", () => {
    const { conn, ws } = connected(100);
    for (let i = 1; i <= 99; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9] }]);
    conn.subscribe("page-1", [{ kinds: [1], limit: 30 }], { priority: true });
    expect(reqIds(ws)).toContain("page-1");
    expect(closeIds(ws)).toEqual([]);
  });

  it("on a full relay: parks one standing sub, sends the request, and restores the sub when it closes", () => {
    const { conn, ws } = connected(100);
    for (let i = 1; i <= 100; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9], "#h": [`g${i}`] }]);
    const before = ws.sent.length;

    conn.subscribe("page-1", [{ kinds: [1], until: 1000, limit: 30 }], { priority: true });
    // CLOSE first so the relay never sees more than its cap, then the REQ.
    expect(frameLog(ws).slice(before)).toEqual(["CLOSE bg-100", "REQ page-1"]);
    expect(conn.wasReqSent("page-1")).toBe(true);
    // The parked sub is still tracked — borrowed from, not dropped.
    expect(conn.hasSubscription("bg-100")).toBe(true);

    conn.closeSubscription("page-1");
    expect(frameLog(ws).slice(before + 2)).toEqual(["CLOSE page-1", "REQ bg-100"]);
    // Re-sent with its own filters.
    expect(JSON.parse(ws.sent[ws.sent.length - 1])).toEqual(["REQ", "bg-100", { kinds: [9], "#h": ["g100"] }]);
    // Net effect on the relay: exactly the 100 standing subs again.
    const live = new Set<string>();
    for (const f of frameLog(ws)) {
      const [type, id] = f.split(" ");
      if (type === "REQ") live.add(id);
      else live.delete(id);
    }
    expect(live.size).toBe(100);
    expect(live.has("bg-100")).toBe(true);
  });

  it("never has more than the cap live on the relay, page after page", () => {
    const { conn, ws } = connected(20);
    for (let i = 1; i <= 20; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9] }]);
    const live = new Set<string>();
    let peak = 0;
    let seen = 0;
    const replay = () => {
      for (const raw of ws.sent.slice(seen)) {
        const m = JSON.parse(raw) as string[];
        if (m[0] === "REQ") live.add(m[1]);
        else if (m[0] === "CLOSE") live.delete(m[1]);
        peak = Math.max(peak, live.size);
      }
      seen = ws.sent.length;
    };
    for (let page = 1; page <= 8; page++) {
      conn.subscribe(`page-${page}`, [{ kinds: [1], limit: 30 }], { priority: true });
      replay();
      expect(live.has(`page-${page}`)).toBe(true);
      conn.closeSubscription(`page-${page}`);
      replay();
    }
    expect(peak).toBe(20);
    expect(live.size).toBe(20);
    for (let i = 1; i <= 20; i++) expect(live.has(`bg-${i}`)).toBe(true);
  });

  it("parks the most recently opened standing sub, not the long-lived ones opened first", () => {
    const { conn, ws } = connected(5);
    for (const id of ["dm-inbox", "bg-chat", "feed", "profile-1", "engagement-9"]) conn.subscribe(id, [{ kinds: [1] }]);
    conn.subscribe("page-1", [{ kinds: [1] }], { priority: true });
    expect(closeIds(ws)).toEqual(["engagement-9"]);
  });

  it("the relay's acknowledgement of the parking CLOSE does not drop the sub", () => {
    const { conn, ws } = connected(5);
    for (let i = 1; i <= 5; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9] }]);
    conn.subscribe("page-1", [{ kinds: [1] }], { priority: true });
    ws.simulateMessage(["CLOSED", "bg-5", ""]); // our relay answers every CLOSE this way
    expect(conn.hasSubscription("bg-5")).toBe(true);
    conn.closeSubscription("page-1");
    expect(reqIds(ws).slice(-1)).toEqual(["bg-5"]);

    // A later, unprompted CLOSED for it is still honoured.
    ws.simulateMessage(["CLOSED", "bg-5", "blocked: gone"]);
    expect(conn.hasSubscription("bg-5")).toBe(false);
  });

  it("an acknowledgement that arrives after the sub was already restored is ignored too", () => {
    const { conn, ws } = connected(5);
    for (let i = 1; i <= 5; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9] }]);
    conn.subscribe("page-1", [{ kinds: [1] }], { priority: true });
    conn.closeSubscription("page-1"); // cancelled at once: bg-5 is back on the wire
    ws.simulateMessage(["CLOSED", "bg-5", ""]); // the ack of the earlier CLOSE, late
    expect(conn.hasSubscription("bg-5")).toBe(true);
  });

  it("a parked sub closed by the app meanwhile is not sent again, and gets no second CLOSE", () => {
    const { conn, ws } = connected(5);
    for (let i = 1; i <= 5; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9] }]);
    conn.subscribe("page-1", [{ kinds: [1] }], { priority: true });
    conn.closeSubscription("bg-5");
    expect(closeIds(ws).filter((id) => id === "bg-5")).toHaveLength(1);
    conn.closeSubscription("page-1");
    expect(reqIds(ws).filter((id) => id === "bg-5")).toHaveLength(1); // only the original REQ
  });

  it("restores the parked sub ahead of subs that were already waiting for a slot", () => {
    const { conn, ws } = connected(5);
    for (let i = 1; i <= 8; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9] }]); // bg-6..8 deferred
    conn.subscribe("page-1", [{ kinds: [1] }], { priority: true });
    expect(closeIds(ws)).toEqual(["bg-5"]); // the newest one that was on the wire
    conn.closeSubscription("page-1");
    expect(reqIds(ws).slice(-1)).toEqual(["bg-5"]); // back first, not bg-6
    conn.closeSubscription("bg-1");
    expect(reqIds(ws).slice(-1)).toEqual(["bg-6"]);
  });

  it("parks at most two subs; a third concurrent request waits at the front of the queue", () => {
    const { conn, ws } = connected(5);
    for (let i = 1; i <= 7; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9] }]);
    for (const id of ["page-1", "page-2", "page-3"]) conn.subscribe(id, [{ kinds: [1] }], { priority: true });
    expect(closeIds(ws)).toEqual(["bg-5", "bg-4"]);
    expect(reqIds(ws)).toContain("page-2");
    expect(reqIds(ws)).not.toContain("page-3");
    // The next slot goes to the waiting request, then the parked subs return.
    conn.closeSubscription("page-1");
    expect(reqIds(ws).slice(-1)).toEqual(["page-3"]);
    conn.closeSubscription("page-2");
    conn.closeSubscription("page-3");
    expect(reqIds(ws).slice(-2).sort()).toEqual(["bg-4", "bg-5"]);
    expect(reqIds(ws)).not.toContain("bg-6");
  });

  it("re-sends a priority request first after a reconnect, with nothing left parked", () => {
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
    expect(ids).toHaveLength(10); // the cap: the request plus nine standing subs
    expect(new Set(ids).size).toBe(10); // each REQ once
    expect(closeIds(ws2)).toEqual([]);
    // When it closes, the standing subs that did not fit follow in order.
    conn.closeSubscription("page-1");
    expect(reqIds(ws2).slice(-1)).toEqual(["bg-10"]);
  });

  it("re-queues a priority request the relay CLOSED for too-many-subscriptions at the front", () => {
    const { conn, ws } = connected(10);
    for (let i = 1; i <= 12; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9] }]);
    conn.subscribe("page-1", [{ kinds: [1] }], { priority: true });
    ws.simulateMessage(["CLOSED", "page-1", "error: too many subscriptions"]);
    expect(conn.hasSubscription("page-1")).toBe(true);
    conn.closeSubscription("bg-1");
    expect(reqIds(ws).slice(-1)).toEqual(["page-1"]); // ahead of everything else waiting
  });

  it("does not park anything while the socket is down; the reconnect sorts it out", () => {
    const conn = createConn("app");
    conn.setMaxSubscriptions(3);
    conn.connect();
    for (let i = 1; i <= 3; i++) conn.subscribe(`bg-${i}`, [{ kinds: [9] }]);
    conn.subscribe("page-1", [{ kinds: [1] }], { priority: true });
    expect(latest().sent).toEqual([]);
    latest().simulateOpen();
    expect(reqIds(latest())).toEqual(["page-1", "bg-1", "bg-2"]);
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

  it("knows which subscriptions the relay has not answered yet", () => {
    const { conn, ws } = connected(10);
    conn.subscribe("a", [{ kinds: [1] }]);
    conn.subscribe("b", [{ kinds: [1] }]);
    ws.simulateMessage(["EOSE", "a"]);
    expect(conn.getUnansweredSubscriptionIds()).toEqual(["b"]);
    // Still "answered" after a reconnect re-sends it: the consumer has its EOSE.
    vi.advanceTimersByTime(RECONNECT.STABLE_AFTER);
    ws.simulateClose();
    vi.advanceTimersByTime(1000);
    latest().simulateOpen();
    expect(conn.getUnansweredSubscriptionIds()).toEqual(["b"]);
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
