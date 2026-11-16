import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { performCleanup } from "../loginFlow";
import { relayManager } from "../relayManager";
import { subscriptionManager } from "../subscriptionManager";
import { APP_RELAY } from "../constants";
import { store } from "@/store";
import { addRelay } from "@/store/slices/relaysSlice";

/**
 * The teardown half of an account switch (switchAccount → performCleanup):
 * every relay goes away without a store update per relay, the connection rows
 * are cleared in one action, and nothing of the old session is left to redial.
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
}

let sockets: MockWebSocket[] = [];
const RELAYS = [APP_RELAY, "wss://relay.damus.io", "wss://mine.example", "wss://host.example", "wss://outbox.example"];

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
  vi.stubGlobal(
    "WebSocket",
    class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    },
  );
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  relayManager.disconnectAll();
});

afterEach(() => {
  relayManager.disconnectAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("performCleanup — relay teardown on account switch", () => {
  function session() {
    for (const url of RELAYS) {
      relayManager.connect(url);
      store.dispatch(addRelay({ url, status: "connected", mode: "read+write", latencyMs: 5, eventCount: 0 }));
    }
    vi.advanceTimersByTime(1000); // let the staggered dials go out
    for (const s of sockets) s.open();
    subscriptionManager.subscribe({ filters: [{ kinds: [1], limit: 10 }], relayUrls: [APP_RELAY] });
    subscriptionManager.subscribe({ filters: [{ kinds: [9], "#h": ["g"] }], relayUrls: ["wss://host.example"] });
  }

  it("clears every connection and its row in the store", () => {
    session();
    expect(Object.keys(store.getState().relays.connections)).toHaveLength(RELAYS.length);

    performCleanup();

    expect(relayManager.getAllConnections().size).toBe(0);
    expect(store.getState().relays.connections).toEqual({});
    expect(subscriptionManager.getActiveCount()).toBe(0);
    for (const s of sockets) expect(s.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("updates the relay rows once, not once or twice per relay", () => {
    session();
    let relayStateChanges = 0;
    let last = store.getState().relays;
    const unsubscribe = store.subscribe(() => {
      if (store.getState().relays !== last) {
        relayStateChanges++;
        last = store.getState().relays;
      }
    });

    performCleanup();
    unsubscribe();

    expect(relayStateChanges).toBe(1);
  });

  it("leaves nothing behind that dials or resubscribes later", () => {
    session();
    const dialed = sockets.length;
    performCleanup();
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets).toHaveLength(dialed);
  });

  it("the next session's relays dial fresh and get none of the old subscriptions", () => {
    session();
    const dialed = sockets.length;
    performCleanup();

    relayManager.connectToBootstrap();
    vi.advanceTimersByTime(1000);
    const fresh = sockets.slice(dialed);
    expect(fresh[0].url).toBe(APP_RELAY); // the app relay first
    for (const s of fresh) s.open();
    vi.advanceTimersByTime(2000);
    for (const s of fresh) {
      expect(s.sent.filter((m) => m.startsWith('["REQ"'))).toEqual([]);
    }
  });
});
