import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NostrEvent } from "@/types/nostr";
import type { Space } from "@/types/space";

// Where a key reconcile gets its roster (docs/E2EE_SPACES.md §5.2–5.3): the
// authority, asked at that moment. A wrong roster here rotates members out or
// hands the key to someone who left, so every doubtful answer must be null.

const api = vi.hoisted(() => ({ fetchAllMemberRoles: vi.fn() }));
vi.mock("@/lib/api/roles", () => ({ fetchAllMemberRoles: api.fetchAllMemberRoles }));

import { relayManager } from "@/lib/nostr/relayManager";
import { verifyBridge } from "@/lib/nostr/verifyWorkerBridge";
import { fetchFreshRoster } from "../freshRoster";

const hex = (c: string) => c.repeat(64);
const RELAY_KEY = hex("f");
const A = hex("a");
const B = hex("b");
const C = hex("c");

function space(over: Partial<Space> = {}): Space {
  return {
    id: "grp1",
    hostRelay: "wss://space.example",
    name: "S",
    isPrivate: false,
    adminPubkeys: [A],
    // Deliberately stale: the store's copy must never be what comes back.
    memberPubkeys: [A],
    feedPubkeys: [],
    mode: "read-write",
    creatorPubkey: A,
    createdAt: 1,
    spaceType: "nip29-native",
    relayPubkey: RELAY_KEY,
    ...over,
  };
}

function members39002(pubkeys: string[], over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: hex("1"),
    pubkey: RELAY_KEY,
    created_at: 1_000,
    kind: 39002,
    tags: [["d", "grp1"], ...pubkeys.map((pk) => ["p", pk])],
    content: "",
    sig: "0".repeat(128),
    ...over,
  };
}

type Sub = { filters: unknown[]; relayUrls: string[]; onEvent: (e: NostrEvent) => void; onEOSE: () => void };
let sub: Sub | null = null;
let closed: string[] = [];

beforeEach(() => {
  sub = null;
  closed = [];
  api.fetchAllMemberRoles.mockReset();
  vi.spyOn(relayManager, "connect").mockImplementation(() => undefined as never);
  vi.spyOn(relayManager, "subscribe").mockImplementation(((opts: Sub) => {
    sub = opts;
    return "roster-sub";
  }) as never);
  vi.spyOn(relayManager, "closeSubscription").mockImplementation(((id: string) => void closed.push(id)) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("native spaces: the relay's newest 39002", () => {
  it("asks the host relay for the member list signed by the pinned relay key", async () => {
    const pending = fetchFreshRoster(space());
    expect(sub!.relayUrls).toEqual(["wss://space.example"]);
    expect(sub!.filters).toEqual([{ kinds: [39002], authors: [RELAY_KEY], "#d": ["grp1"], limit: 1 }]);
    sub!.onEvent(members39002([A, B, C]));
    sub!.onEOSE();
    expect(await pending).toEqual([A, B, C]);
    expect(closed).toEqual(["roster-sub"]);
  });

  it("takes the newest when several arrive", async () => {
    const pending = fetchFreshRoster(space());
    sub!.onEvent(members39002([A, B], { created_at: 2_000, id: hex("2") }));
    sub!.onEvent(members39002([A, B, C], { created_at: 1_000 }));
    sub!.onEOSE();
    expect(await pending).toEqual([A, B]);
  });

  it("ignores a member list from any other author or for another group", async () => {
    const pending = fetchFreshRoster(space());
    sub!.onEvent(members39002([A, C], { pubkey: hex("e") }));
    sub!.onEvent(members39002([A, C], { tags: [["d", "other"], ["p", A], ["p", C]] }));
    sub!.onEOSE();
    expect(await pending).toBeNull();
  });

  it("is null when the signature does not verify", async () => {
    vi.spyOn(verifyBridge, "verify").mockResolvedValueOnce(false);
    const pending = fetchFreshRoster(space());
    sub!.onEvent(members39002([A, B]));
    sub!.onEOSE();
    expect(await pending).toBeNull();
  });

  it("is null without a pinned relay key, without asking anyone", async () => {
    expect(await fetchFreshRoster(space({ relayPubkey: undefined }))).toBeNull();
    expect(sub).toBeNull();
  });

  it("is null when the relay has no member list, and when it never answers", async () => {
    const empty = fetchFreshRoster(space());
    sub!.onEOSE();
    expect(await empty).toBeNull();

    vi.useFakeTimers();
    const silent = fetchFreshRoster(space());
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await silent).toBeNull();
    expect(closed).toEqual(["roster-sub", "roster-sub"]);
  });
});

describe("backend-backed spaces: the backend's member list", () => {
  const platform = () => space({ spaceType: "platform", relayPubkey: undefined });

  it("returns the backend's members, not the store's", async () => {
    api.fetchAllMemberRoles.mockResolvedValueOnce([{ pubkey: A, roles: [] }, { pubkey: B, roles: [] }, { pubkey: B, roles: [] }]);
    expect(await fetchFreshRoster(platform())).toEqual([A, B]);
    expect(api.fetchAllMemberRoles).toHaveBeenCalledWith("grp1");
    expect(sub).toBeNull();
  });

  it("is null on an error or an empty answer", async () => {
    api.fetchAllMemberRoles.mockRejectedValueOnce(new Error("503"));
    expect(await fetchFreshRoster(platform())).toBeNull();
    api.fetchAllMemberRoles.mockResolvedValueOnce([]);
    expect(await fetchFreshRoster(platform())).toBeNull();
  });
});
