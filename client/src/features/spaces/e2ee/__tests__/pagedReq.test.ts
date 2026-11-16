import { describe, it, expect } from "vitest";
import type { NostrEvent, NostrFilter } from "@/types/nostr";
import { fetchAllPaged, type PagedReqTransport } from "../pagedReq";

// A relay that behaves like ours: newest first, `until` inclusive, and at most
// MAX_LIMIT events per REQ whatever the filter asks for.
const MAX_LIMIT = 500;

function fakeRelay(events: NostrEvent[], opts: { stall?: boolean } = {}): PagedReqTransport & { reqs: NostrFilter[] } {
  const reqs: NostrFilter[] = [];
  return {
    reqs,
    subscribe({ filters, relayUrls, onEvent, onEOSE }) {
      const f = filters[0];
      reqs.push(f);
      if (opts.stall) return "stalled";
      const matching = events
        .filter((e) => (f.until === undefined || e.created_at <= f.until) && (f.since === undefined || e.created_at >= f.since))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, Math.min(f.limit ?? MAX_LIMIT, MAX_LIMIT));
      queueMicrotask(() => {
        for (const e of matching) onEvent(e, relayUrls[0]);
        onEOSE();
      });
      return `sub-${reqs.length}`;
    },
    close() {},
  };
}

function grants(n: number, perSecond = 3): NostrEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i.toString(16).padStart(64, "0"),
    pubkey: "a".repeat(64),
    created_at: 1_700_000_000 + Math.floor(i / perSecond),
    kind: 4291,
    tags: [],
    content: "",
    sig: "0".repeat(128),
  }));
}

describe("fetchAllPaged", () => {
  it("gets every event past the relay's per-REQ cap", async () => {
    const all = grants(1_234);
    const relay = fakeRelay(all);
    const seen = new Set<string>();
    const result = await fetchAllPaged(relay, { filter: { kinds: [4291] }, relayUrl: "wss://r", onEvent: (e) => seen.add(e.id) });
    expect(result).toEqual({ complete: true, count: 1_234 });
    expect(seen.size).toBe(1_234);
    expect(relay.reqs.length).toBeGreaterThanOrEqual(3);
    // One unpaged REQ would have missed the oldest 734.
    expect(relay.reqs[0].until).toBeUndefined();
    expect(relay.reqs[1].until).toBeDefined();
  });

  it("finishes in one REQ when everything fits", async () => {
    const relay = fakeRelay(grants(12));
    const result = await fetchAllPaged(relay, { filter: { kinds: [4291] }, relayUrl: "wss://r", onEvent: () => {} });
    expect(result).toEqual({ complete: true, count: 12 });
    expect(relay.reqs).toHaveLength(1);
  });

  it("reports an incomplete answer when a page never ends", async () => {
    const relay = fakeRelay(grants(10), { stall: true });
    const result = await fetchAllPaged(relay, {
      filter: { kinds: [4291] },
      relayUrl: "wss://r",
      onEvent: () => {},
      pageTimeoutMs: 20,
    });
    expect(result.complete).toBe(false);
  });

  it("reports an incomplete answer when the relay layer throws", async () => {
    const relay: PagedReqTransport = {
      subscribe: () => {
        throw new Error("no connection");
      },
      close: () => {},
    };
    const result = await fetchAllPaged(relay, { filter: { kinds: [4291] }, relayUrl: "wss://r", onEvent: () => {} });
    expect(result.complete).toBe(false);
  });
});
