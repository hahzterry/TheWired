import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Space } from "@/types/space";

// Capture the reconnect callback registered at module load (hoisted so the
// vi.mock factory can assign into it).
const hoisted = vi.hoisted(() => ({
  reconnectCb: undefined as ((url: string) => void) | undefined,
}));

vi.mock("../subscriptionManager", () => ({
  subscriptionManager: {
    subscribe: vi.fn(),
    subscribeOnce: vi.fn(),
    close: vi.fn(),
    getReconnectSince: vi.fn(),
  },
}));

// flushEventPipeline is called by loadMore* after an all-eose; stub it out.
vi.mock("../eventPipeline", () => ({ flushEventPipeline: vi.fn() }));

vi.mock("../relayManager", () => ({
  relayManager: {
    onReconnect: (cb: (url: string) => void) => {
      hoisted.reconnectCb = cb;
      return () => {};
    },
    pinRelay: vi.fn(),
    waitForReadRelay: vi.fn(() => Promise.resolve(true)),
  },
}));

import { subscriptionManager } from "../subscriptionManager";
import { relayManager } from "../relayManager";
import {
  startBackgroundChatSubs,
  openBgChatSub,
  closeBgChatSub,
  stopAllBgChatSubs,
  switchSpaceChannel,
  refreshSpaceFeed,
  loadMoreSpaceFeed,
  enterSpace,
  loadMoreFriendsFeed,
  refreshFriendsFeed,
} from "../groupSubscriptions";
import { store, resetAll } from "@/store";
import { setActiveChannel, setChannelSubscription } from "@/store/slices/spacesSlice";
import { trackFeedTimestamp, setLoadMoreError } from "@/store/slices/feedSlice";
import { setFollowList } from "@/store/slices/identitySlice";
import { FRIENDS_FEED_ID } from "@/features/friends/friendsFeedConstants";

const subscribe = vi.mocked(subscriptionManager.subscribe);
const subscribeOnce = vi.mocked(subscriptionManager.subscribeOnce);
const close = vi.mocked(subscriptionManager.close);
const getReconnectSince = vi.mocked(subscriptionManager.getReconnectSince);
const pinRelay = vi.mocked(relayManager.pinRelay);
const waitForReadRelay = vi.mocked(relayManager.waitForReadRelay);

function space(id: string, hostRelay: string): Space {
  return {
    id,
    hostRelay,
    name: id,
    isPrivate: false,
    adminPubkeys: [],
    memberPubkeys: [],
    feedPubkeys: [],
    mode: "read-write",
    creatorPubkey: "pk",
    createdAt: 0,
  };
}

/** Let the page request's promise chain (relay wait → subscribeOnce → settle) run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Extract the filter object passed to a given subscribe() call. */
function filterOf(callIndex: number) {
  return (subscribe.mock.calls[callIndex][0] as {
    filters: { kinds: number[]; "#h": string[]; since: number }[];
    relayUrls: string[];
  });
}

beforeEach(() => {
  stopAllBgChatSubs(); // clear module state carried over from a prior test
  subscribe.mockReset();
  subscribeOnce.mockReset();
  close.mockReset();
  getReconnectSince.mockReset();
  let n = 0;
  subscribe.mockImplementation(() => `sub-${++n}`);
  subscribeOnce.mockResolvedValue({ reason: "all-eose" });
  pinRelay.mockClear();
  waitForReadRelay.mockReset().mockResolvedValue(true);
});

describe("groupSubscriptions — bg chat sub collapse", () => {
  it("opens one sub per host relay carrying all that host's space ids in #h", () => {
    startBackgroundChatSubs([
      space("A", "wss://host1"),
      space("B", "wss://host1"),
      space("C", "wss://host2"),
    ]);
    expect(subscribe).toHaveBeenCalledTimes(2);

    const byHost = subscribe.mock.calls.map((c) => c[0] as ReturnType<typeof filterOf>);
    const h1 = byHost.find((o) => o.relayUrls[0] === "wss://host1")!;
    const h2 = byHost.find((o) => o.relayUrls[0] === "wss://host2")!;

    expect([...h1.filters[0]["#h"]].sort()).toEqual(["A", "B"]);
    expect(h2.filters[0]["#h"]).toEqual(["C"]);
    // kind:7 rides along so chat reactions are delivered (mobile wire contract).
    expect(h1.filters[0].kinds).toEqual([7, 9, 1068, 5, 9005]);
    // The backend's space-config-changed nudge is d-tagged, so it
    // rides a second filter on the same sub, over the same ids.
    const nudge = h1.filters[1] as unknown as { kinds: number[]; "#d": string[] };
    expect(nudge.kinds).toEqual([20900]);
    expect([...nudge["#d"]].sort()).toEqual(["A", "B"]);
  });

  it("collapses many spaces on one host into a single subscription", () => {
    const spaces = Array.from({ length: 27 }, (_, i) => space(`s${i}`, "wss://host"));
    startBackgroundChatSubs(spaces);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(filterOf(0).filters[0]["#h"]).toHaveLength(27);
  });

  it("skips spaces with no hostRelay", () => {
    startBackgroundChatSubs([space("A", ""), space("B", "wss://host")]);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(filterOf(0).filters[0]["#h"]).toEqual(["B"]);
  });

  it("adds a joined space to its host sub (close + reopen with the new id)", () => {
    startBackgroundChatSubs([space("A", "wss://host1")]);
    subscribe.mockClear();
    close.mockClear();

    openBgChatSub(space("B", "wss://host1"));

    expect(close).toHaveBeenCalledTimes(1); // old host sub closed
    expect(subscribe).toHaveBeenCalledTimes(1); // reopened
    expect([...filterOf(0).filters[0]["#h"]].sort()).toEqual(["A", "B"]);
  });

  it("is idempotent — re-adding the same space does nothing", () => {
    startBackgroundChatSubs([space("A", "wss://host1")]);
    subscribe.mockClear();
    close.mockClear();

    openBgChatSub(space("A", "wss://host1"));

    expect(subscribe).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("removing a space reopens its host sub without that id", () => {
    startBackgroundChatSubs([space("A", "wss://h"), space("B", "wss://h")]);
    subscribe.mockClear();
    close.mockClear();

    closeBgChatSub("A");

    expect(close).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(filterOf(0).filters[0]["#h"]).toEqual(["B"]);
  });

  it("removing the last space on a host closes the sub entirely", () => {
    startBackgroundChatSubs([space("A", "wss://h")]);
    subscribe.mockClear();
    close.mockClear();

    closeBgChatSub("A");

    expect(close).toHaveBeenCalledTimes(1);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("stopAll closes every host sub", () => {
    startBackgroundChatSubs([space("A", "wss://h1"), space("B", "wss://h2")]);
    close.mockClear();
    stopAllBgChatSubs();
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe("groupSubscriptions — reconnect since freshness", () => {
  it("rebuilds a host sub with a fresh since on reconnect", async () => {
    startBackgroundChatSubs([space("A", "wss://h")]);
    subscribe.mockClear();
    close.mockClear();
    getReconnectSince.mockReturnValue(1234);

    hoisted.reconnectCb?.("wss://h"); // rebuild is deferred to a microtask
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1); // stale sub closed
    expect(subscribe).toHaveBeenCalledTimes(1); // reopened fresh
    expect(filterOf(0).filters[0].since).toBe(1234);
    expect(filterOf(0).filters[0]["#h"]).toEqual(["A"]);
  });

  it("a reconnect for a host with no bg sub is a no-op", async () => {
    hoisted.reconnectCb?.("wss://unknown");
    await Promise.resolve();
    expect(subscribe).not.toHaveBeenCalled();
  });
});

// ── Subscription leak fixes (Phase 3a, Part A) ──────────────────────────────
describe("groupSubscriptions — channel-switch leak (#38)", () => {
  beforeEach(() => {
    store.dispatch(resetAll());
    let n = 0;
    subscribe.mockImplementation(() => `sub-${++n}`);
  });

  it("closes the previous channel's sub on switch, and never the bg chat sub", () => {
    // A prior channel sub for spaceA lives in Redux; a bg chat sub lives in the
    // module map (hostRelaySubs), NOT Redux.
    store.dispatch(setChannelSubscription({ channelId: "spaceA:chan1", subId: "old-sub" }));
    startBackgroundChatSubs([space("spaceA", "wss://h")]); // bg sub → "sub-1"
    // The caller overwrites activeChannelId to the NEW channel BEFORE switching —
    // this is exactly the condition that made the old sub unrecoverable (#38).
    store.dispatch(setActiveChannel("spaceA:chan2"));

    const sp = space("spaceA", "wss://h");
    sp.memberPubkeys = ["pk1"];
    switchSpaceChannel(sp, "notes", "chan2");

    // PRE-fix: the fn read the already-overwritten activeChannelId, so "old-sub"
    // was never closed (the leak). POST-fix it prefix-closes the space's subs.
    expect(close).toHaveBeenCalledWith("old-sub");
    expect(store.getState().spaces.subscriptions["spaceA:chan1"]).toBeUndefined();
    // The always-on bg chat sub is in hostRelaySubs, not Redux, so it survives.
    expect(close).not.toHaveBeenCalledWith("sub-1");
  });
});

describe("groupSubscriptions — refresh-feed leak", () => {
  beforeEach(() => {
    store.dispatch(resetAll());
  });

  it("uses the auto-closing subscribeOnce so the refresh sub can't leak", async () => {
    const sp = space("spaceR", "wss://h");
    sp.memberPubkeys = ["pk1"];

    refreshSpaceFeed(sp, "notes");
    await settle();

    // PRE-fix: a manual subscribe()+onEOSE that forgot to close → the sub
    // streamed forever. POST-fix: subscribeOnce guarantees close on every path
    // (EOSE / timeout / no-relays), structurally eliminating the leak class.
    expect(subscribeOnce).toHaveBeenCalledTimes(1);
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe("groupSubscriptions — stale *MetaSubs after account switch (A4)", () => {
  beforeEach(() => {
    store.dispatch(resetAll());
    let n = 0;
    subscribe.mockImplementation(() => `sub-${++n}`);
  });

  it("re-subscribes space metadata for a new account after teardown", () => {
    enterSpace("grp", "wss://h");
    expect(subscribe).toHaveBeenCalledTimes(2); // metadata + layout

    // Same session, no teardown → idempotent early-return (correct).
    subscribe.mockClear();
    enterSpace("grp", "wss://h");
    expect(subscribe).not.toHaveBeenCalled();

    // Teardown (logout / account switch). PRE-fix this left spaceMetaSubs/
    // spaceLayoutSubs populated, so the next enterSpace early-returned and
    // metadata silently never re-subscribed for the new account.
    stopAllBgChatSubs();
    subscribe.mockClear();
    enterSpace("grp", "wss://h");
    expect(subscribe).toHaveBeenCalledTimes(2);
  });
});

describe("groupSubscriptions — loadMore hasMore on timeout vs all-eose (#78)", () => {
  beforeEach(() => {
    store.dispatch(resetAll());
  });

  it("a TIMEOUT must NOT conclude 'no more' — leaves hasMore true", async () => {
    const sp = space("spaceP", "wss://h");
    sp.memberPubkeys = ["pk1"];
    const contextId = "spaceP:notes";
    store.dispatch(trackFeedTimestamp({ contextId, createdAt: 1000 })); // oldestAt=1000
    subscribeOnce.mockResolvedValue({ reason: "timeout" });

    loadMoreSpaceFeed(sp, "notes");
    await settle();

    // PRE-fix: ANY EOSE (incl. the backstop timeout) flipped hasMore off, falsely
    // ending pagination after a slow relay. POST-fix: only all-eose can.
    expect(store.getState().feed.meta[contextId].hasMore).toBe(true);
  });

  it("an ALL-EOSE with no older events concludes hasMore false", async () => {
    const sp = space("spaceQ", "wss://h");
    sp.memberPubkeys = ["pk1"];
    const contextId = "spaceQ:notes";
    store.dispatch(trackFeedTimestamp({ contextId, createdAt: 1000 }));
    subscribeOnce.mockResolvedValue({ reason: "all-eose" });

    loadMoreSpaceFeed(sp, "notes");
    await settle();

    // flushEventPipeline is mocked → oldestAt unchanged → honest end-of-feed.
    expect(store.getState().feed.meta[contextId].hasMore).toBe(false);
  });
});

describe("groupSubscriptions — space-only music backfill", () => {
  type OnceArg = { filters: { kinds: number[]; "#h": string[]; limit: number }[]; relayUrls: string[] };
  const onceCall = (i: number) => subscribeOnce.mock.calls[i][0] as unknown as OnceArg;
  /** Let the sequential subscribeOnce chain (one await per REQ) run out. */
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const spaceRelease = (id: string, spaceId: string) =>
    ({
      addressableId: `33123:author:${id}`,
      pubkey: "author",
      title: id,
      visibility: "space",
      spaceIds: [spaceId],
      artistPubkeys: [],
      featuredArtists: [],
      collaborators: [],
      hashtags: [],
      trackRefs: [],
      createdAt: 1,
    }) as never;

  beforeEach(() => {
    store.dispatch(resetAll());
  });

  it("asks each host once, with one small filter per space, and never as a standing sub", async () => {
    startBackgroundChatSubs([space("A", "wss://h1"), space("B", "wss://h1"), space("C", "wss://h2")]);
    await settle();

    expect(subscribeOnce).toHaveBeenCalledTimes(2);
    const h1 = onceCall(0);
    expect(h1.relayUrls).toEqual(["wss://h1"]);
    expect(h1.filters).toEqual([
      { kinds: [31683, 33123], "#h": ["A"], limit: 12 },
      { kinds: [31683, 33123], "#h": ["B"], limit: 12 },
    ]);
    expect(onceCall(1).relayUrls).toEqual(["wss://h2"]);
    // Only the always-on bg chat subs go through subscribe(): one per host.
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("carries live space-only music on the existing bg sub instead of a new one", () => {
    startBackgroundChatSubs([space("A", "wss://h")]);
    const live = filterOf(0).filters[2];
    expect(live.kinds).toEqual([31683, 33123]);
    expect(live["#h"]).toEqual(["A"]);
    expect(typeof live.since).toBe("number");
  });

  it("stays under the relay's filter cap by chunking many spaces", async () => {
    startBackgroundChatSubs(Array.from({ length: 20 }, (_, i) => space(`s${i}`, "wss://h")));
    await settle();
    expect(subscribeOnce.mock.calls.map((_, i) => onceCall(i).filters.length)).toEqual([8, 8, 4]);
  });

  it("fetches a newly joined space alone, not the ones already fetched", async () => {
    startBackgroundChatSubs([space("A", "wss://h")]);
    await settle();
    openBgChatSub(space("B", "wss://h"));
    await settle();
    expect(subscribeOnce).toHaveBeenCalledTimes(2);
    expect(onceCall(1).filters.map((f) => f["#h"][0])).toEqual(["B"]);
  });

  it("fetches again after leaving and rejoining", async () => {
    startBackgroundChatSubs([space("A", "wss://h")]);
    await settle();
    closeBgChatSub("A");
    openBgChatSub(space("A", "wss://h"));
    await settle();
    expect(subscribeOnce).toHaveBeenCalledTimes(2);
  });

  it("asks an empty space once more (a REQ that beat AUTH returns nothing), then stops", async () => {
    vi.useFakeTimers();
    try {
      startBackgroundChatSubs([space("A", "wss://h"), space("B", "wss://h")]);
      await settle();
      // A's music arrived; B came back empty.
      store.dispatch({ type: "music/addAlbums", payload: [spaceRelease("ep", "A")] });

      await vi.advanceTimersByTimeAsync(6_000);
      await settle();
      expect(subscribeOnce).toHaveBeenCalledTimes(2);
      expect(onceCall(1).filters.map((f) => f["#h"][0])).toEqual(["B"]);

      await vi.advanceTimersByTimeAsync(30_000);
      await settle();
      expect(subscribeOnce).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the pending retry on logout", async () => {
    vi.useFakeTimers();
    try {
      startBackgroundChatSubs([space("A", "wss://h")]);
      await settle();
      stopAllBgChatSubs();
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(subscribeOnce).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("groupSubscriptions — load more is delivered or says why not", () => {
  const contextId = "spaceL:notes";
  function member(): Space {
    const sp = space("spaceL", "wss://h");
    sp.memberPubkeys = ["pk1"];
    return sp;
  }
  const meta = () => store.getState().feed.meta[contextId];

  beforeEach(() => {
    store.dispatch(resetAll());
    store.dispatch(trackFeedTimestamp({ contextId, createdAt: 1000 })); // oldestAt = 1000
  });

  it("asks as a priority one-shot so a saturated relay cap cannot starve it", async () => {
    loadMoreSpaceFeed(member(), "notes");
    await settle();
    expect(subscribeOnce).toHaveBeenCalledTimes(1);
    const opts = subscribeOnce.mock.calls[0][0];
    expect(opts.priority).toBe(true);
    expect(opts.filters[0]).toMatchObject({ authors: ["pk1"], until: 999 });
  });

  // Refreshes (the automatic first fetch of a feed among them) are ordinary
  // one-shots: two of them must not be able to crowd a "load more" out.
  it("a refresh is NOT a priority request, automatic or manual", async () => {
    refreshSpaceFeed(member(), "notes", true);
    refreshSpaceFeed(member(), "notes", false);
    store.dispatch(setFollowList({ follows: ["f1"], createdAt: 5 }));
    refreshFriendsFeed("notes", true);
    refreshFriendsFeed("notes");
    await settle();
    expect(subscribeOnce).toHaveBeenCalledTimes(4);
    for (const call of subscribeOnce.mock.calls) expect(call[0].priority).toBeUndefined();
  });

  it("only load more is priority, for space feeds and the friends feed", async () => {
    loadMoreSpaceFeed(member(), "notes");
    store.dispatch(setFollowList({ follows: ["f1"], createdAt: 5 }));
    store.dispatch(trackFeedTimestamp({ contextId: `${FRIENDS_FEED_ID}:notes`, createdAt: 1000 }));
    loadMoreFriendsFeed("notes");
    await settle();
    expect(subscribeOnce.mock.calls.map((c) => c[0].priority)).toEqual([true, true]);
  });

  it("shows the loading state while the request is out and clears it after", async () => {
    let finish!: (v: { reason: "all-eose" }) => void;
    subscribeOnce.mockReturnValue(new Promise((r) => { finish = r; }));
    loadMoreSpaceFeed(member(), "notes");
    await settle();
    expect(meta().isLoadingMore).toBe(true);
    finish({ reason: "all-eose" });
    await settle();
    expect(meta().isLoadingMore).toBe(false);
  });

  it("no relay connected: waits briefly, then reports the request could not be sent", async () => {
    waitForReadRelay.mockResolvedValue(false);
    loadMoreSpaceFeed(member(), "notes");
    await settle();
    expect(subscribeOnce).not.toHaveBeenCalled(); // nothing to send it to
    expect(meta()).toMatchObject({ isLoadingMore: false, hasMore: true, loadMoreError: "unreachable" });
  });

  it("a relay connecting during the wait lets the request go out", async () => {
    let connected!: (ok: boolean) => void;
    waitForReadRelay.mockReturnValue(new Promise((r) => { connected = r; }));
    loadMoreSpaceFeed(member(), "notes");
    await settle();
    expect(subscribeOnce).not.toHaveBeenCalled();
    connected(true);
    await settle();
    expect(subscribeOnce).toHaveBeenCalledTimes(1);
    expect(meta().loadMoreError ?? null).toBeNull();
  });

  it("timed out without ever reaching a relay → unreachable, with hasMore kept", async () => {
    subscribeOnce.mockResolvedValue({ reason: "timeout", sentTo: 0 });
    loadMoreSpaceFeed(member(), "notes");
    await settle();
    expect(meta()).toMatchObject({ isLoadingMore: false, hasMore: true, loadMoreError: "unreachable" });
  });

  it("sent but unanswered → timeout error rather than a silent no-op", async () => {
    subscribeOnce.mockResolvedValue({ reason: "timeout", sentTo: 2 });
    loadMoreSpaceFeed(member(), "notes");
    await settle();
    expect(meta()).toMatchObject({ isLoadingMore: false, hasMore: true, loadMoreError: "timeout" });
  });

  it("a slow relay is not an error when another one delivered older notes", async () => {
    subscribeOnce.mockImplementation(async () => {
      store.dispatch(trackFeedTimestamp({ contextId, createdAt: 500 })); // the page arrived
      return { reason: "timeout", sentTo: 2 };
    });
    loadMoreSpaceFeed(member(), "notes");
    await settle();
    expect(meta().loadMoreError ?? null).toBeNull();
    expect(meta().hasMore).toBe(true);
  });

  it("an honest end of feed is not an error", async () => {
    subscribeOnce.mockResolvedValue({ reason: "all-eose", sentTo: 1 });
    loadMoreSpaceFeed(member(), "notes");
    await settle();
    expect(meta().hasMore).toBe(false);
    expect(meta().loadMoreError ?? null).toBeNull();
  });

  it("retrying clears the previous error as soon as the new attempt starts", async () => {
    store.dispatch(setLoadMoreError({ contextId, value: "unreachable" }));
    let finish!: (v: { reason: "all-eose" }) => void;
    subscribeOnce.mockReturnValue(new Promise((r) => { finish = r; }));
    loadMoreSpaceFeed(member(), "notes");
    await settle();
    expect(meta()).toMatchObject({ isLoadingMore: true, loadMoreError: null });
    finish({ reason: "all-eose" });
    await settle();
  });

  it("the friends feed gets the same treatment", async () => {
    store.dispatch(setFollowList({ follows: ["f1"], createdAt: 5 }));
    const friends = `${FRIENDS_FEED_ID}:notes`;
    store.dispatch(trackFeedTimestamp({ contextId: friends, createdAt: 1000 }));
    subscribeOnce.mockResolvedValue({ reason: "timeout", sentTo: 0 });
    loadMoreFriendsFeed("notes");
    await settle();
    expect(subscribeOnce.mock.calls[0][0].priority).toBe(true);
    expect(store.getState().feed.meta[friends]).toMatchObject({ isLoadingMore: false, loadMoreError: "unreachable" });
  });
});

describe("groupSubscriptions — space hosts are pinned (never dropped as dead fan-out)", () => {
  it("pins the host of the background chat sub", () => {
    startBackgroundChatSubs([space("s1", "wss://relay-a"), space("s2", "wss://relay-b")]);
    expect(pinRelay).toHaveBeenCalledWith("wss://relay-a");
    expect(pinRelay).toHaveBeenCalledWith("wss://relay-b");
  });

  it("pins the relay a native space's metadata is read from", () => {
    enterSpace("native-1", "wss://groups.example");
    expect(pinRelay).toHaveBeenCalledWith("wss://groups.example");
  });

  it("pins the relays of the open chat channel", () => {
    store.dispatch(resetAll());
    switchSpaceChannel(space("s3", "wss://relay-c"), "chat");
    expect(pinRelay).toHaveBeenCalledWith("wss://relay-c");
  });
});
