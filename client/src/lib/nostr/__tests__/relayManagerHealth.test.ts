import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { relayManager } from "../relayManager";
import { APP_RELAY, INDEXER_RELAYS, RECONNECT } from "../constants";

/**
 * Relay health at the manager level: which relays are dropped after striking
 * out and which never are, the reset on `online`, the staggered priority
 * redial, the quiet teardown, and user-initiated requests getting through a
 * saturated cap. The "app relay" tests are regressions for the sticky
 * contract: none of this may tear the platform relay's socket down or re-send
 * its subscriptions.
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

  constructor(public url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  /** Connect failed, or the connection dropped. */
  fail() {
    this.readyState = MockWebSocket.CLOSED;
    this.onerror?.();
    this.onclose?.();
  }
}

let sockets: MockWebSocket[] = [];
let dialedAt: number[] = [];
let t0 = 0;

const DAMUS = "wss://relay.damus.io"; // a bootstrap relay, not loopback
const DEAD = "wss://dead.example";
const HOST = "wss://space-host.example";

const socketsFor = (url: string) => sockets.filter((s) => s.url === url);
const lastSocket = (url: string) => socketsFor(url)[socketsFor(url).length - 1];
const frames = (ws: MockWebSocket, type: string) =>
  ws.sent.map((s) => JSON.parse(s) as unknown[]).filter((m) => m[0] === type);
const reqIds = (ws: MockWebSocket) => frames(ws, "REQ").map((m) => m[1] as string);
const has = (url: string) => relayManager.getAllConnections().has(url);
const noop = () => {};

/** Fail `url`'s current dial `times` times, waiting out the backoff in between. */
function failDials(url: string, times: number): void {
  for (let i = 0; i < times; i++) {
    const before = socketsFor(url).length;
    lastSocket(url).fail();
    for (let waited = 0; waited < 10 * 60_000 && socketsFor(url).length === before && has(url); waited += 250) {
      vi.advanceTimersByTime(250);
    }
  }
}

/** Put `urls` into backoff together: at least 5 failed connects each, the last
 *  one just now, so every one of them is waiting 16 s or more. */
function failTogether(urls: string[]): void {
  for (const url of urls) failDials(url, 4);
  for (const url of urls) {
    if (lastSocket(url).readyState === MockWebSocket.CONNECTING) lastSocket(url).fail();
  }
}

/** Connect a relay that proves the network is up. */
function connectOutsideRelay(): MockWebSocket {
  relayManager.connect(DAMUS);
  lastSocket(DAMUS).open();
  return lastSocket(DAMUS);
}

beforeEach(() => {
  sockets = [];
  dialedAt = [];
  vi.useFakeTimers();
  t0 = Date.now();
  vi.stubGlobal(
    "WebSocket",
    class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
        dialedAt.push(Date.now() - t0);
      }
    },
  );
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no nip11")));
  vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter
  relayManager.setGlobalCallbacks({ onStatusChange: noop, onRelayRemoved: noop });
  relayManager.disconnectAll();
});

afterEach(() => {
  relayManager.disconnectAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("relayManager — dead fan-out relays are dropped for the session", () => {
  it("drops an outbox target after three failed connects and stops dialing it", () => {
    const removed = vi.fn();
    relayManager.setGlobalCallbacks({ onRelayRemoved: removed });
    connectOutsideRelay();

    relayManager.subscribe({ filters: [{ kinds: [1], authors: ["a"] }], relayUrls: [DEAD], onEvent: noop });
    expect(socketsFor(DEAD)).toHaveLength(1); // auto-dialed for the subscription
    failDials(DEAD, 3);

    expect(socketsFor(DEAD)).toHaveLength(3);
    expect(has(DEAD)).toBe(false);
    expect(relayManager.isSessionDropped(DEAD)).toBe(true);
    expect(removed).toHaveBeenCalledWith(DEAD);

    // Nothing redials it, however long the session runs.
    vi.advanceTimersByTime(60 * 60_000);
    expect(socketsFor(DEAD)).toHaveLength(3);
  });

  it("does not dial a dropped relay again when a later subscription targets it", () => {
    connectOutsideRelay();
    relayManager.subscribe({ filters: [{ kinds: [1] }], relayUrls: [DEAD], onEvent: noop });
    failDials(DEAD, 3);

    // Another profile whose relay list names the same dead relay.
    relayManager.subscribe({ filters: [{ kinds: [1], authors: ["b"] }], relayUrls: [DEAD, DAMUS], onEvent: noop });
    vi.advanceTimersByTime(60_000);
    expect(socketsFor(DEAD)).toHaveLength(3);
    expect(has(DEAD)).toBe(false);
  });

  it("answers the waiting subscriptions with an end-of-stored-events when it drops the relay", () => {
    connectOutsideRelay();
    const onEOSE = vi.fn();
    const subId = relayManager.subscribe({ filters: [{ kinds: [1] }], relayUrls: [DEAD], onEvent: noop, onEOSE });
    failDials(DEAD, 2);
    expect(onEOSE).not.toHaveBeenCalled();
    failDials(DEAD, 1);
    expect(onEOSE).toHaveBeenCalledTimes(1);
    expect(onEOSE).toHaveBeenCalledWith(subId, DEAD);
  });

  it("does not send a second end-of-stored-events to a subscription the relay already answered", () => {
    connectOutsideRelay();
    const answered = vi.fn();
    const waiting = vi.fn();
    const a = relayManager.subscribe({ filters: [{ kinds: [1], authors: ["a"] }], relayUrls: [DEAD], onEvent: noop, onEOSE: answered });
    // The relay is up for a moment and answers the first subscription…
    lastSocket(DEAD).open();
    lastSocket(DEAD).onmessage?.({ data: JSON.stringify(["EOSE", a]) });
    expect(answered).toHaveBeenCalledTimes(1);
    // …then a second one is opened, and the relay dies before answering it.
    const b = relayManager.subscribe({ filters: [{ kinds: [1], authors: ["b"] }], relayUrls: [DEAD], onEvent: noop, onEOSE: waiting });
    failDials(DEAD, 4); // the drop of the live socket, then three failed connects
    expect(has(DEAD)).toBe(false);

    expect(waiting).toHaveBeenCalledTimes(1);
    expect(waiting).toHaveBeenCalledWith(b, DEAD);
    expect(answered).toHaveBeenCalledTimes(1); // no made-up second EOSE
  });

  it("drops a relay that accepts the socket and hangs up straight away", () => {
    connectOutsideRelay();
    relayManager.subscribe({ filters: [{ kinds: [1] }], relayUrls: [DEAD], onEvent: noop });
    for (let i = 0; i < 3; i++) {
      lastSocket(DEAD).open();
      vi.advanceTimersByTime(100);
      failDials(DEAD, 1);
    }
    expect(has(DEAD)).toBe(false);
    expect(socketsFor(DEAD)).toHaveLength(3);
  });

  it("drops a struck-out search relay dialed with { transient: true }", () => {
    connectOutsideRelay();
    relayManager.connect(DEAD, "read", { transient: true });
    failDials(DEAD, 3);
    expect(has(DEAD)).toBe(false);
  });

  it("does not blame the relay while nothing outside is connected (network down)", () => {
    // Only the loopback platform relay is up: no proof the network works.
    relayManager.connect(APP_RELAY);
    lastSocket(APP_RELAY).open();
    relayManager.subscribe({ filters: [{ kinds: [1] }], relayUrls: [DEAD], onEvent: noop });
    failDials(DEAD, 6);
    expect(has(DEAD)).toBe(true);
    expect(relayManager.isSessionDropped(DEAD)).toBe(false);
    expect(socketsFor(DEAD)).toHaveLength(7); // still retrying, with backoff
  });

  it("does not drop anything while the browser reports offline", () => {
    connectOutsideRelay();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    relayManager.subscribe({ filters: [{ kinds: [1] }], relayUrls: [DEAD], onEvent: noop });
    failDials(DEAD, 5);
    expect(has(DEAD)).toBe(true);
  });

  it("gives a DM recipient's dead inbox relay a fresh set of attempts on the next send", () => {
    connectOutsideRelay();
    relayManager.connectPeer(DEAD);
    failDials(DEAD, 3);
    expect(has(DEAD)).toBe(false);

    relayManager.connectPeer(DEAD);
    expect(has(DEAD)).toBe(true);
    expect(relayManager.isPeerOnly(DEAD)).toBe(true);
    failDials(DEAD, 3);
    expect(has(DEAD)).toBe(false);
    expect(socketsFor(DEAD)).toHaveLength(6);
  });
});

describe("relayManager — chosen relays are retried forever, never dropped", () => {
  it("keeps retrying the app relay with its backoff capped at MAX_DELAY", () => {
    connectOutsideRelay();
    relayManager.connect(APP_RELAY);
    failDials(APP_RELAY, 12);
    expect(has(APP_RELAY)).toBe(true);
    expect(socketsFor(APP_RELAY)).toHaveLength(13);
    const times = sockets.map((s, i) => [s.url, dialedAt[i]] as const).filter(([u]) => u === APP_RELAY).map(([, t]) => t);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(Math.max(...gaps)).toBe(RECONNECT.MAX_DELAY);
  });

  // Regression: the cap for a dead chosen relay was briefly 5 minutes.
  it("keeps retrying a relay from the user's own list, never more than 60 s apart", () => {
    connectOutsideRelay();
    relayManager.reconcileUserRelays([{ url: "wss://mine.example", mode: "read+write" }]);
    failDials("wss://mine.example", 12);
    expect(has("wss://mine.example")).toBe(true);
    expect(relayManager.isSessionDropped("wss://mine.example")).toBe(false);
    const times = sockets.map((s, i) => [s.url, dialedAt[i]] as const).filter(([u]) => u === "wss://mine.example").map(([, t]) => t);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, ...Array(6).fill(RECONNECT.MAX_DELAY)]);
  });

  it("a space host that is down for two minutes is retried within a minute of coming back", () => {
    connectOutsideRelay();
    relayManager.pinRelay(HOST);
    relayManager.subscribe({ filters: [{ kinds: [9], "#h": ["g"] }], relayUrls: [HOST], onEvent: noop });
    const start = Date.now();
    // Every dial fails for two minutes.
    while (Date.now() - start < 120_000) {
      if (lastSocket(HOST).readyState === MockWebSocket.CONNECTING) lastSocket(HOST).fail();
      vi.advanceTimersByTime(250);
    }
    // The host is back: the next scheduled dial is at most 60 s away.
    const before = socketsFor(HOST).length;
    const backAt = Date.now();
    while (socketsFor(HOST).length === before || lastSocket(HOST).readyState !== MockWebSocket.CONNECTING) {
      vi.advanceTimersByTime(250);
    }
    expect(Date.now() - backAt).toBeLessThanOrEqual(RECONNECT.MAX_DELAY);
    lastSocket(HOST).open();
    expect(relayManager.getAllConnections().get(HOST)!.getStatus()).toBe("connected");
  });

  it("keeps retrying a relay a feature connected explicitly (space host on send)", () => {
    connectOutsideRelay();
    relayManager.connect(HOST, "read+write");
    failDials(HOST, 8);
    expect(has(HOST)).toBe(true);
  });

  it("keeps retrying a space host that was only ever auto-dialed, once pinned", () => {
    connectOutsideRelay();
    relayManager.pinRelay(HOST);
    relayManager.subscribe({ filters: [{ kinds: [9], "#h": ["g"] }], relayUrls: [HOST], onEvent: noop });
    expect(lastSocket(HOST)).toBeDefined();
    failDials(HOST, 8);
    expect(has(HOST)).toBe(true);
    // Pinning does not change how it was dialed: still read-only, so untargeted
    // publishes do not start going to it.
    expect(relayManager.getAllConnections().get(HOST)!.mode).toBe("read");
  });

  it("promotes a relay that is pinned while it is already failing", () => {
    connectOutsideRelay();
    relayManager.subscribe({ filters: [{ kinds: [1] }], relayUrls: [HOST], onEvent: noop });
    failDials(HOST, 2);
    relayManager.pinRelay(HOST); // the user joined a space hosted there
    failDials(HOST, 6);
    expect(has(HOST)).toBe(true);
  });

  it("keeps retrying bootstrap and indexer relays the app itself relies on", () => {
    connectOutsideRelay();
    const indexer = INDEXER_RELAYS[0];
    relayManager.subscribe({ filters: [{ kinds: [0], authors: ["a"] }], relayUrls: [indexer, "wss://nos.lol"], onEvent: noop });
    failDials(indexer, 6);
    failDials("wss://nos.lol", 6);
    expect(has(indexer)).toBe(true);
    expect(has("wss://nos.lol")).toBe(true);
  });

  it("lifts a session drop once the relay is chosen", () => {
    connectOutsideRelay();
    relayManager.subscribe({ filters: [{ kinds: [1] }], relayUrls: [DEAD], onEvent: noop });
    failDials(DEAD, 3);
    expect(relayManager.isSessionDropped(DEAD)).toBe(true);

    relayManager.pinRelay(DEAD);
    expect(relayManager.isSessionDropped(DEAD)).toBe(false);
    relayManager.subscribe({ filters: [{ kinds: [9] }], relayUrls: [DEAD], onEvent: noop });
    expect(socketsFor(DEAD)).toHaveLength(4);
    failDials(DEAD, 6);
    expect(has(DEAD)).toBe(true); // now a chosen relay: never dropped
  });
});

describe("relayManager — asking again for a chosen relay that is backing off", () => {
  /** A space host that failed 5 connects and now waits 16 s for the next one. */
  function hostInBackoff() {
    connectOutsideRelay();
    relayManager.connect(HOST, "read+write");
    failDials(HOST, 4);
    lastSocket(HOST).fail();
    return socketsFor(HOST).length;
  }

  // Regression: connect() became a no-op while a retry was pending, so a send
  // to a host that had just come back waited for the backoff (and timed out).
  it("connect() dials at once, so a send to a host that came back does not wait for the backoff", async () => {
    const dials = hostInBackoff();
    vi.advanceTimersByTime(6000); // the host is back; its next scheduled dial is still 10 s away

    // What useChat does before publishing.
    relayManager.connect(HOST, "read+write");
    const waiting = relayManager.waitForConnection(HOST, 10_000);
    expect(socketsFor(HOST)).toHaveLength(dials + 1);
    lastSocket(HOST).open();
    await expect(waiting).resolves.toBe(true);
  });

  it("is rate-limited per relay: calls in quick succession dial once", () => {
    const dials = hostInBackoff();
    vi.advanceTimersByTime(RECONNECT.KICK_INTERVAL);
    for (let i = 0; i < 25; i++) relayManager.connect(HOST, "read+write");
    expect(socketsFor(HOST)).toHaveLength(dials + 1);
    // That dial fails; more "make sure it is connected" calls right away do nothing.
    lastSocket(HOST).fail();
    for (let i = 0; i < 25; i++) relayManager.connect(HOST, "read+write");
    expect(socketsFor(HOST)).toHaveLength(dials + 1);
    vi.advanceTimersByTime(RECONNECT.KICK_INTERVAL);
    relayManager.connect(HOST, "read+write");
    expect(socketsFor(HOST)).toHaveLength(dials + 2);
  });

  it("one relay's kick does not use up another's", () => {
    connectOutsideRelay();
    relayManager.connect(HOST, "read+write");
    relayManager.connect("wss://host-two.example", "read+write");
    failTogether([HOST, "wss://host-two.example"]);
    vi.advanceTimersByTime(RECONNECT.KICK_INTERVAL);
    const a = socketsFor(HOST).length;
    const b = socketsFor("wss://host-two.example").length;
    relayManager.connect(HOST);
    relayManager.connect("wss://host-two.example");
    expect(socketsFor(HOST)).toHaveLength(a + 1);
    expect(socketsFor("wss://host-two.example")).toHaveLength(b + 1);
  });

  it("the user's own relays and the app relay are kicked the same way", () => {
    connectOutsideRelay();
    relayManager.reconcileUserRelays([{ url: "wss://mine.example", mode: "read+write" }]);
    relayManager.connect(APP_RELAY);
    failTogether(["wss://mine.example", APP_RELAY]);
    vi.advanceTimersByTime(RECONNECT.KICK_INTERVAL);
    const mine = socketsFor("wss://mine.example").length;
    const app = socketsFor(APP_RELAY).length;
    relayManager.reconcileUserRelays([{ url: "wss://mine.example", mode: "read+write" }]);
    relayManager.connect(APP_RELAY, "read+write");
    expect(socketsFor("wss://mine.example")).toHaveLength(mine + 1);
    expect(socketsFor(APP_RELAY)).toHaveLength(app + 1);
  });

  it("a transient caller never shortens a backoff", () => {
    connectOutsideRelay();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false); // keep the fan-out relay from being dropped
    relayManager.subscribe({ filters: [{ kinds: [1] }], relayUrls: [DEAD], onEvent: noop });
    failDials(DEAD, 4);
    lastSocket(DEAD).fail();
    vi.advanceTimersByTime(RECONNECT.KICK_INTERVAL);
    const dials = socketsFor(DEAD).length;
    relayManager.connect(DEAD, "read", { transient: true });
    relayManager.subscribe({ filters: [{ kinds: [1], authors: ["b"] }], relayUrls: [DEAD], onEvent: noop });
    relayManager.connectPeer(DEAD);
    expect(socketsFor(DEAD)).toHaveLength(dials);
  });

  it("does not touch a relay that is connected or connecting", () => {
    connectOutsideRelay();
    relayManager.connect(HOST);
    for (let i = 0; i < 10; i++) relayManager.connect(HOST);
    lastSocket(HOST).open();
    for (let i = 0; i < 10; i++) relayManager.connect(HOST);
    expect(socketsFor(HOST)).toHaveLength(1);
  });
});

describe("relayManager — strikes reset", () => {
  it("resets on a connection that holds", () => {
    connectOutsideRelay();
    relayManager.subscribe({ filters: [{ kinds: [1] }], relayUrls: [DEAD], onEvent: noop });
    failDials(DEAD, 2);
    lastSocket(DEAD).open();
    vi.advanceTimersByTime(RECONNECT.STABLE_AFTER);
    expect(relayManager.getAllConnections().get(DEAD)!.getStrikes()).toBe(0);
    // The drop of that healthy connection is not a strike; it takes three
    // failed connects after it to drop the relay.
    failDials(DEAD, 3);
    expect(has(DEAD)).toBe(true);
    failDials(DEAD, 1);
    expect(has(DEAD)).toBe(false);
  });

  it("on `online`: redials what was backing off, at once, with strikes cleared", () => {
    connectOutsideRelay();
    relayManager.connect(HOST);
    failDials(HOST, 6); // deep in its backoff
    const conn = relayManager.getAllConnections().get(HOST)!;
    lastSocket(HOST).fail();
    expect(conn.getStrikes()).toBe(7);
    const before = socketsFor(HOST).length;

    window.dispatchEvent(new Event("online"));
    expect(conn.getStrikes()).toBe(0);
    expect(socketsFor(HOST)).toHaveLength(before + 1);
  });

  it("on `online`: gives a dropped relay another chance when a live subscription still wants it", () => {
    connectOutsideRelay();
    const subId = relayManager.subscribe({ filters: [{ kinds: [1] }], relayUrls: [DEAD], onEvent: noop });
    failDials(DEAD, 3);

    window.dispatchEvent(new Event("online"));
    expect(relayManager.isSessionDropped(DEAD)).toBe(false);
    expect(socketsFor(DEAD)).toHaveLength(4);
    // It gets the subscription's REQ when it comes up.
    lastSocket(DEAD).open();
    expect(reqIds(lastSocket(DEAD))).toEqual([subId]);
  });

  it("on `online`: does not redial a dropped relay nothing subscribes to any more", () => {
    connectOutsideRelay();
    const subId = relayManager.subscribe({ filters: [{ kinds: [1] }], relayUrls: [DEAD], onEvent: noop });
    failDials(DEAD, 3);
    relayManager.closeSubscription(subId);

    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(5000);
    expect(socketsFor(DEAD)).toHaveLength(3);
    expect(relayManager.isSessionDropped(DEAD)).toBe(false); // eligible again when next needed
  });

  describe("the network evidently returning (an outside relay connects after none were)", () => {
    /** Outside relay up and stable, HOST chosen. */
    function setup() {
      const damus = connectOutsideRelay();
      vi.advanceTimersByTime(RECONNECT.STABLE_AFTER);
      relayManager.connect(HOST);
      return damus;
    }
    /** Take the outside relay down and keep its dials failing for `ms`. */
    function outage(ms: number) {
      lastSocket(DAMUS).fail();
      const start = Date.now();
      while (Date.now() - start < ms) {
        vi.advanceTimersByTime(250);
        if (lastSocket(DAMUS).readyState === MockWebSocket.CONNECTING && Date.now() - start < ms) lastSocket(DAMUS).fail();
      }
      // Wait for its next dial and let it through.
      while (lastSocket(DAMUS).readyState !== MockWebSocket.CONNECTING) vi.advanceTimersByTime(250);
    }

    it("after a real outage: clears the others' backoff and redials them at once", () => {
      setup();
      lastSocket(DAMUS).fail();
      failDials(HOST, 5);
      lastSocket(HOST).fail(); // HOST now waits 32 s
      const hostDials = socketsFor(HOST).length;
      // The outside relay has been gone for well over NETWORK_DOWN_MIN by now.
      while (lastSocket(DAMUS).readyState !== MockWebSocket.CONNECTING) vi.advanceTimersByTime(250);
      lastSocket(DAMUS).open();
      expect(socketsFor(HOST)).toHaveLength(hostDials + 1);
      expect(relayManager.getAllConnections().get(HOST)!.getStrikes()).toBe(0);
    });

    // Regression: every flap of the only outside relay used to count as "the
    // network is back" and replayed each dead relay's dials.
    it("a relay that flaps (gone for a second or two) restores nothing", () => {
      setup();
      relayManager.subscribe({ filters: [{ kinds: [1] }], relayUrls: [DEAD], onEvent: noop });
      failDials(DEAD, 3);
      failDials(HOST, 5);
      lastSocket(HOST).fail();
      expect(relayManager.isSessionDropped(DEAD)).toBe(true);
      const hostDials = socketsFor(HOST).length;
      const strikes = relayManager.getAllConnections().get(HOST)!.getStrikes();

      for (let flap = 0; flap < 5; flap++) {
        lastSocket(DAMUS).fail();
        vi.advanceTimersByTime(1500); // back after its 1 s reconnect delay
        lastSocket(DAMUS).open();
        vi.advanceTimersByTime(RECONNECT.STABLE_AFTER);
      }
      expect(relayManager.isSessionDropped(DEAD)).toBe(true);
      expect(socketsFor(DEAD)).toHaveLength(3);
      expect(relayManager.getAllConnections().get(HOST)!.getStrikes()).toBeGreaterThanOrEqual(strikes);
      // HOST was only dialed by its own schedule (at most once in those ~32 s).
      expect(socketsFor(HOST).length - hostDials).toBeLessThanOrEqual(1);
    });

    it("restores at most once per RESTORE_MIN_INTERVAL, however often the relay goes away for long", () => {
      setup();
      relayManager.subscribe({ filters: [{ kinds: [1] }], relayUrls: [DEAD], onEvent: noop });
      failDials(DEAD, 3);

      outage(RECONNECT.NETWORK_DOWN_MIN + 1000);
      lastSocket(DAMUS).open(); // first long outage ends: restore, DEAD gets another chance
      expect(socketsFor(DEAD)).toHaveLength(4);
      failDials(DEAD, 3);
      expect(relayManager.isSessionDropped(DEAD)).toBe(true);
      expect(socketsFor(DEAD)).toHaveLength(6);

      vi.advanceTimersByTime(RECONNECT.STABLE_AFTER);
      outage(RECONNECT.NETWORK_DOWN_MIN + 1000);
      lastSocket(DAMUS).open(); // a second long outage within the minute: no restore
      expect(socketsFor(DEAD)).toHaveLength(6);
      expect(relayManager.isSessionDropped(DEAD)).toBe(true);

      vi.advanceTimersByTime(RECONNECT.RESTORE_MIN_INTERVAL);
      outage(RECONNECT.NETWORK_DOWN_MIN + 1000);
      lastSocket(DAMUS).open(); // a minute later it may restore again
      expect(socketsFor(DEAD)).toHaveLength(7);
    });

    it("the first outside relay of a session restores nothing (there was no outage)", () => {
      relayManager.connect(APP_RELAY);
      lastSocket(APP_RELAY).open();
      relayManager.connect(HOST);
      failDials(HOST, 4);
      lastSocket(HOST).fail();
      const hostDials = socketsFor(HOST).length;
      vi.advanceTimersByTime(RECONNECT.KICK_INTERVAL);
      connectOutsideRelay();
      expect(socketsFor(HOST)).toHaveLength(hostDials);
    });

    it("the browser `online` event is not rate-limited", () => {
      setup();
      for (let i = 0; i < 3; i++) {
        failDials(HOST, 3);
        lastSocket(HOST).fail();
        const before = socketsFor(HOST).length;
        window.dispatchEvent(new Event("online"));
        expect(socketsFor(HOST)).toHaveLength(before + 1);
      }
    });
  });
});

describe("relayManager — staggered redial in priority order", () => {
  it("dials the app relay and the first few relays at once, then spaces the rest out by rank", () => {
    // What a login asks for, deliberately in the worst order: fan-out targets
    // first, the user's relays next, the platform relay last.
    relayManager.subscribe({
      filters: [{ kinds: [1], authors: ["a"] }],
      relayUrls: ["wss://t1.example", "wss://t2.example", "wss://t3.example", "wss://t4.example", "wss://t5.example", "wss://t6.example"],
      onEvent: noop,
    });
    relayManager.reconcileUserRelays([
      { url: "wss://read-only.example", mode: "read" },
      { url: "wss://write-1.example", mode: "read+write" },
      { url: "wss://write-2.example", mode: "write" },
    ]);
    relayManager.connect(APP_RELAY);

    // Same tick: the burst (4) plus the app relay, which never waits.
    expect(sockets.map((s) => s.url)).toEqual([
      "wss://t1.example", "wss://t2.example", "wss://t3.example", "wss://t4.example", APP_RELAY,
    ]);

    vi.advanceTimersByTime(10 * RECONNECT.DIAL_SPACING);
    expect(sockets.slice(5).map((s) => s.url)).toEqual([
      "wss://write-1.example", // the user's write relays first
      "wss://write-2.example",
      "wss://read-only.example", // then their read-only ones
      "wss://t5.example", // fan-out targets last
      "wss://t6.example",
    ]);
    const gaps = dialedAt.slice(6).map((t, i) => t - dialedAt[5 + i]);
    expect(gaps).toEqual([40, 40, 40, 40].map(() => RECONNECT.DIAL_SPACING));
    expect(dialedAt[5]).toBe(RECONNECT.DIAL_SPACING);
  });

  it("dials a single relay immediately when nothing else is going on", () => {
    relayManager.connect(HOST);
    expect(socketsFor(HOST)).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    relayManager.connect("wss://another.example");
    expect(socketsFor("wss://another.example")).toHaveLength(1);
  });

  it("refills the burst after a quiet moment", () => {
    for (let i = 1; i <= 6; i++) relayManager.connect(`wss://a${i}.example`);
    expect(sockets).toHaveLength(4);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(6);
    for (let i = 1; i <= 4; i++) relayManager.connect(`wss://b${i}.example`);
    expect(sockets).toHaveLength(10); // all four at once again
  });

  it("never dials a queued relay that was removed before its turn", () => {
    for (let i = 1; i <= 6; i++) relayManager.connect(`wss://a${i}.example`);
    relayManager.disconnect("wss://a5.example");
    vi.advanceTimersByTime(1000);
    expect(socketsFor("wss://a5.example")).toHaveLength(0);
    expect(socketsFor("wss://a6.example")).toHaveLength(1);
  });

  it("subscriptions made while a relay waits its turn are sent once it opens", () => {
    for (let i = 1; i <= 5; i++) relayManager.connect(`wss://a${i}.example`);
    const subId = relayManager.subscribe({ filters: [{ kinds: [1] }], relayUrls: ["wss://a5.example"], onEvent: noop });
    expect(socketsFor("wss://a5.example")).toHaveLength(0); // still queued
    vi.advanceTimersByTime(RECONNECT.DIAL_SPACING);
    lastSocket("wss://a5.example").open();
    expect(reqIds(lastSocket("wss://a5.example"))).toEqual([subId]);
  });

  it("waitForConnection still resolves for a relay whose dial was queued", async () => {
    for (let i = 1; i <= 5; i++) relayManager.connect(`wss://a${i}.example`);
    const waiting = relayManager.waitForConnection("wss://a5.example", 5000);
    vi.advanceTimersByTime(RECONNECT.DIAL_SPACING);
    lastSocket("wss://a5.example").open();
    await expect(waiting).resolves.toBe(true);
  });
});

describe("relayManager — quiet teardown (account switch)", () => {
  it("disconnectAll fires no per-relay status or removed callbacks", () => {
    for (const url of [APP_RELAY, DAMUS, HOST]) relayManager.connect(url);
    for (const s of sockets) s.open();
    const onStatusChange = vi.fn();
    const onRelayRemoved = vi.fn();
    relayManager.setGlobalCallbacks({ onStatusChange, onRelayRemoved });

    relayManager.disconnectAll();
    expect(onStatusChange).not.toHaveBeenCalled();
    expect(onRelayRemoved).not.toHaveBeenCalled();
    expect(relayManager.getAllConnections().size).toBe(0);
  });

  it("a single disconnect() still reports the removal", () => {
    relayManager.connect(HOST);
    const onRelayRemoved = vi.fn();
    relayManager.setGlobalCallbacks({ onRelayRemoved });
    relayManager.disconnect(HOST);
    expect(onRelayRemoved).toHaveBeenCalledWith(HOST);
  });

  it("drops queued dials and session state, so the next account starts clean", () => {
    connectOutsideRelay();
    relayManager.subscribe({ filters: [{ kinds: [1] }], relayUrls: [DEAD], onEvent: noop });
    failDials(DEAD, 3);
    for (let i = 1; i <= 8; i++) relayManager.connect(`wss://a${i}.example`);
    const before = sockets.length;

    relayManager.disconnectAll();
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(before); // nothing left in the queue dialed
    expect(relayManager.isSessionDropped(DEAD)).toBe(false);

    // The new session gets a full burst straight away.
    for (let i = 1; i <= 4; i++) relayManager.connect(`wss://n${i}.example`);
    expect(sockets).toHaveLength(before + 4);
  });
});

describe("relayManager — user-initiated requests get through a saturated cap", () => {
  function saturateAppRelay(): MockWebSocket {
    relayManager.connect(APP_RELAY);
    const ws = lastSocket(APP_RELAY);
    ws.open();
    for (let i = 0; i < 140; i++) {
      relayManager.subscribe({ filters: [{ kinds: [9], "#h": [`g${i}`] }], relayUrls: [APP_RELAY], onEvent: noop });
    }
    return ws;
  }

  it("a standing sub is deferred, a priority one is on the wire immediately", () => {
    const ws = saturateAppRelay();
    expect(reqIds(ws)).toHaveLength(100); // standing subs use the whole cap

    const standing = relayManager.subscribe({ filters: [{ kinds: [1], limit: 30 }], onEvent: noop });
    expect(reqIds(ws)).not.toContain(standing);
    expect(relayManager.getSubscriptionDelivery(standing)).toEqual({ relays: 1, sent: 0 });

    const page = relayManager.subscribe({ filters: [{ kinds: [1], until: 1000, limit: 30 }], onEvent: noop, priority: true });
    expect(reqIds(ws)).toContain(page);
    expect(relayManager.getSubscriptionDelivery(page)).toEqual({ relays: 1, sent: 1 });
    // It borrowed exactly one standing sub's slot…
    const parked = frames(ws, "CLOSE").map((m) => m[1] as string);
    expect(parked).toHaveLength(1);
    // …and gives it back when it closes.
    relayManager.closeSubscription(page);
    expect(reqIds(ws).slice(-1)).toEqual(parked);
  });

  it("delivers page after page while the cap stays saturated, with the relay never over its cap", () => {
    const ws = saturateAppRelay();
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
    replay();
    const standing = new Set(live);
    for (let n = 0; n < 10; n++) {
      const page = relayManager.subscribe({ filters: [{ kinds: [1], until: 1000 - n, limit: 30 }], onEvent: noop, priority: true });
      replay();
      expect(live.has(page)).toBe(true);
      relayManager.closeSubscription(page);
      replay();
    }
    expect(peak).toBe(100);
    // Every standing sub that was live before is live again afterwards.
    expect(live).toEqual(standing);
  });

  it("keeps the priority when the request is forwarded to a relay that connects later", () => {
    const page = relayManager.subscribe({ filters: [{ kinds: [1], limit: 30 }], relayUrls: [HOST], onEvent: noop, priority: true });
    const conn = relayManager.getAllConnections().get(HOST)!;
    conn.setMaxSubscriptions(10);
    for (let i = 0; i < 20; i++) {
      relayManager.subscribe({ filters: [{ kinds: [9], "#h": [`g${i}`] }], relayUrls: [HOST], onEvent: noop });
    }
    lastSocket(HOST).open();
    vi.advanceTimersByTime(2000); // staggered resubscribe batches
    const ids = reqIds(lastSocket(HOST));
    expect(ids[0]).toBe(page);
    expect(ids).toHaveLength(10);
  });

  it("reports sent: 0 when no relay is connected to take the request", () => {
    const page = relayManager.subscribe({ filters: [{ kinds: [1], limit: 30 }], onEvent: noop, priority: true });
    expect(relayManager.getSubscriptionDelivery(page)).toEqual({ relays: 0, sent: 0 });
  });

  it("waitForReadRelay: true at once when connected, true when one connects in time, false otherwise", async () => {
    const none = relayManager.waitForReadRelay(1000);
    vi.advanceTimersByTime(1000);
    await expect(none).resolves.toBe(false);

    relayManager.connect(HOST);
    const later = relayManager.waitForReadRelay(1000);
    vi.advanceTimersByTime(300);
    lastSocket(HOST).open();
    await expect(later).resolves.toBe(true);

    await expect(relayManager.waitForReadRelay(1000)).resolves.toBe(true);
  });
});

describe("relayManager — the app relay is left alone (sticky-contract regressions)", () => {
  /** App relay up with standing subs, plus a healthy outside relay. */
  function session() {
    relayManager.connect(APP_RELAY);
    const app = lastSocket(APP_RELAY);
    app.open();
    const damus = connectOutsideRelay();
    const subs: string[] = [];
    for (let i = 0; i < 12; i++) {
      subs.push(relayManager.subscribe({ filters: [{ kinds: [9], "#h": [`g${i}`] }], relayUrls: [APP_RELAY], onEvent: noop }));
    }
    vi.advanceTimersByTime(RECONNECT.STABLE_AFTER);
    return { app, damus, subs };
  }

  function expectUntouched(app: MockWebSocket, subs: string[]) {
    expect(socketsFor(APP_RELAY)).toHaveLength(1); // never redialed
    expect(app.readyState).toBe(MockWebSocket.OPEN);
    expect(frames(app, "CLOSE")).toEqual([]); // nothing torn down
    const ids = reqIds(app);
    for (const id of subs) expect(ids.filter((x) => x === id)).toHaveLength(1); // nothing re-sent
  }

  it("a fan-out relay striking out does not touch it", () => {
    const { app, subs } = session();
    relayManager.subscribe({ filters: [{ kinds: [1] }], relayUrls: [DEAD], onEvent: noop });
    failDials(DEAD, 3);
    expectUntouched(app, subs);
  });

  it("`online` does not touch it", () => {
    const { app, subs } = session();
    relayManager.connect(HOST);
    failDials(HOST, 4);
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(5000);
    expectUntouched(app, subs);
  });

  it("another relay proving the network is back does not touch it", () => {
    const { app, damus, subs } = session();
    damus.fail();
    vi.advanceTimersByTime(1500);
    lastSocket(DAMUS).open();
    expectUntouched(app, subs);
  });

  it("a priority request with room to spare closes none of its subscriptions", () => {
    const { app, subs } = session(); // 12 subs on a cap of 100
    const page = relayManager.subscribe({ filters: [{ kinds: [1], limit: 30 }], onEvent: noop, priority: true });
    expect(reqIds(app)).toContain(page);
    expect(frames(app, "CLOSE")).toEqual([]);
    relayManager.closeSubscription(page);
    expect(frames(app, "CLOSE").map((m) => m[1])).toEqual([page]);
    for (const id of subs) expect(reqIds(app).filter((x) => x === id)).toHaveLength(1);
    expect(socketsFor(APP_RELAY)).toHaveLength(1);
  });

  it("at a full cap it borrows one slot and gives it back; the socket and every other sub stay put", () => {
    const { app, subs } = session();
    for (let i = 0; i < 130; i++) {
      subs.push(relayManager.subscribe({ filters: [{ kinds: [7], "#e": [`e${i}`] }], relayUrls: [APP_RELAY], onEvent: noop }));
    }
    const liveBefore = reqIds(app); // the 100 that fit
    expect(liveBefore).toHaveLength(100);

    const page = relayManager.subscribe({ filters: [{ kinds: [1], limit: 30 }], onEvent: noop, priority: true });
    const closed = frames(app, "CLOSE").map((m) => m[1] as string);
    expect(closed).toHaveLength(1); // one standing sub parked, no more
    expect(liveBefore).toContain(closed[0]);
    expect(reqIds(app)).toContain(page);

    relayManager.closeSubscription(page);
    // The parked sub is back; nothing else was re-sent or closed.
    expect(frames(app, "CLOSE").map((m) => m[1])).toEqual([closed[0], page]);
    const ids = reqIds(app);
    expect(ids.filter((x) => x === closed[0])).toHaveLength(2);
    for (const id of liveBefore) if (id !== closed[0]) expect(ids.filter((x) => x === id)).toHaveLength(1);
    // The long-lived subs opened first were never the ones borrowed from.
    expect(subs.slice(0, 12)).not.toContain(closed[0]);
    expect(socketsFor(APP_RELAY)).toHaveLength(1);
    expect(app.readyState).toBe(MockWebSocket.OPEN);
  });

  it("reconcile, pruning and repeated connect() calls still never recreate it", () => {
    const { app, subs } = session();
    relayManager.reconcileUserRelays([{ url: "wss://mine.example", mode: "read+write" }], { pruneBootstrap: true });
    relayManager.reconcileUserRelays([{ url: APP_RELAY, mode: "read" }], { pruneBootstrap: true });
    for (let i = 0; i < 10; i++) relayManager.connect(APP_RELAY, "read+write");
    relayManager.pinRelay(APP_RELAY);
    vi.advanceTimersByTime(5000);
    expectUntouched(app, subs);
  });

  it("when it does drop, it reconnects on its own schedule and sends each subscription once", () => {
    const { app, subs } = session();
    app.fail();
    vi.advanceTimersByTime(1000);
    const app2 = lastSocket(APP_RELAY);
    expect(app2).not.toBe(app);
    window.dispatchEvent(new Event("online")); // mid-handshake: must not open a third socket
    expect(socketsFor(APP_RELAY)).toHaveLength(2);
    app2.open();
    vi.advanceTimersByTime(2000);
    const ids = reqIds(app2);
    for (const id of subs) expect(ids.filter((x) => x === id)).toHaveLength(1);
  });
});

describe("relayManager — account-switch redial (teardown, then everything at once)", () => {
  /** What performLogin asks for right after performCleanup → disconnectAll(). */
  function relogin() {
    relayManager.disconnectAll();
    relayManager.connectToBootstrap();
    relayManager.reconcileUserRelays(
      [
        { url: "wss://read-a.example", mode: "read" },
        { url: "wss://mine-1.example", mode: "read+write" },
        { url: "wss://read-b.example", mode: "read" },
        { url: "wss://mine-2.example", mode: "write" },
        { url: "wss://mine-3.example", mode: "read+write" },
      ],
      { pruneBootstrap: false },
    );
    // Outbox targets of whatever profile was on screen.
    relayManager.subscribe({
      filters: [{ kinds: [1], authors: ["a"] }],
      relayUrls: ["wss://out-1.example", "wss://out-2.example", "wss://out-3.example"],
      onEvent: noop,
    });
  }

  it("the app relay is dialed first and in the same tick", () => {
    for (const url of [DAMUS, HOST, APP_RELAY]) relayManager.connect(url);
    for (const s of [...sockets]) s.open();
    const before = sockets.length;
    relogin();
    expect(sockets[before].url).toBe(APP_RELAY);
    expect(dialedAt[before]).toBe(dialedAt[dialedAt.length - 1]); // nothing later yet
  });

  it("does not dial everything in one tick: at most the burst plus the app relay", () => {
    relogin();
    expect(sockets).toHaveLength(RECONNECT.DIAL_BURST + 1);
    // 12 relays in total: the other 7 follow one per DIAL_SPACING.
    vi.advanceTimersByTime(3 * RECONNECT.DIAL_SPACING);
    expect(sockets).toHaveLength(RECONNECT.DIAL_BURST + 1 + 3);
    vi.advanceTimersByTime(20 * RECONNECT.DIAL_SPACING);
    expect(sockets).toHaveLength(12);
    expect(new Set(sockets.map((s) => s.url)).size).toBe(12); // each relay dialed once
  });

  it("queues the rest as: write relays, then read-only relays, then fan-out targets", () => {
    relogin();
    vi.advanceTimersByTime(20 * RECONNECT.DIAL_SPACING);
    // Dialed at once: the app relay (never waits) and the burst of four —
    // the other bootstrap relays and the first relay of the user's list.
    expect(sockets.slice(0, RECONNECT.DIAL_BURST + 1).map((s) => s.url)).toEqual([
      APP_RELAY,
      DAMUS,
      "wss://relay.primal.net",
      "wss://nos.lol",
      "wss://read-a.example",
    ]);
    // Spaced out after that, by rank rather than by the order they were asked for.
    expect(sockets.slice(RECONNECT.DIAL_BURST + 1).map((s) => s.url)).toEqual([
      "wss://mine-1.example",
      "wss://mine-2.example",
      "wss://mine-3.example",
      "wss://read-b.example",
      "wss://out-1.example",
      "wss://out-2.example",
      "wss://out-3.example",
    ]);
  });

  it("subscriptions of the new session reach every relay exactly once as each one opens", () => {
    relogin();
    const subId = relayManager.subscribe({ filters: [{ kinds: [1], limit: 20 }], onEvent: noop }); // broadcast
    vi.advanceTimersByTime(20 * RECONNECT.DIAL_SPACING);
    for (const s of sockets) s.open();
    vi.advanceTimersByTime(2000);
    for (const url of [APP_RELAY, "wss://mine-1.example", "wss://read-a.example"]) {
      expect(reqIds(lastSocket(url)).filter((id) => id === subId)).toHaveLength(1);
    }
    // A write-only relay is not a read relay: no broadcast REQ there.
    expect(reqIds(lastSocket("wss://mine-2.example"))).not.toContain(subId);
  });

  it("nothing of the previous account's session survives the teardown", () => {
    connectOutsideRelay();
    const stale = relayManager.subscribe({ filters: [{ kinds: [9] }], relayUrls: [APP_RELAY], onEvent: noop });
    relogin();
    vi.advanceTimersByTime(20 * RECONNECT.DIAL_SPACING);
    for (const s of sockets) if (s.readyState === MockWebSocket.CONNECTING) s.open();
    vi.advanceTimersByTime(2000);
    expect(reqIds(lastSocket(APP_RELAY))).not.toContain(stale);
  });
});
