/**
 * Characterization of the event pipeline: what it does today, stage by stage,
 * recorded as ordered traces of every store dispatch and every call it makes
 * on its injected dependencies and feature hooks.
 *
 * The traces are the contract. They pin
 *  - the stage order (validate → dedup → verify → dispatch → index → notify → flush),
 *  - burst batching and the flush order,
 *  - the `indexEvent` routing of every kind it handles,
 *  - which failures unmark an event from the dedup LRU so a redelivery retries,
 *  - how a gift wrap leaves the normal path and how its rumor is routed.
 *
 * Each test builds its own pipeline with `createEventPipeline`, so the dedup
 * LRU and the burst buffer start empty; the store is the app's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const trace: string[] = [];
  /** 64-hex ids and pubkeys print as `#<hex without leading zeros>`. */
  const alias = (s: string) => s.replace(/[0-9a-f]{64}/g, (m) => "#" + (m.replace(/^0+/, "") || "0"));
  const fmt = (v: unknown): string => {
    if (v === undefined) return "";
    if (typeof v === "function") return "<fn>";
    const json = JSON.stringify(v, (_k, val) => {
      if (val && typeof val === "object" && !Array.isArray(val) && typeof val.id === "string" && typeof val.sig === "string") {
        return `event:${val.id}`;
      }
      // Parsed music objects are long; their address identifies them.
      if (val && typeof val === "object" && typeof val.addressableId === "string" && Object.keys(val).length > 4) {
        return { addressableId: val.addressableId };
      }
      return val;
    });
    return alias(json ?? "");
  };
  const call = (name: string, ...args: unknown[]) => {
    trace.push(`${name}(${args.map(fmt).join(", ")})`);
  };
  return {
    trace,
    fmt,
    call,
    unwrap: (async () => {
      throw new Error("no rumor queued");
    }) as (...a: unknown[]) => Promise<unknown>,
    native: { group: false, layout: false, relaySet: false },
  };
});

vi.mock("@/lib/nostr/giftWrap", () => ({
  unwrapGiftWrap: (event: unknown, opts: { now?: number }) => {
    h.call("unwrapGiftWrap", event, { now: opts?.now });
    return h.unwrap(event, opts);
  },
}));
vi.mock("@/store/thunks/spaceMembers", async (orig) => ({
  ...(await orig<typeof import("@/store/thunks/spaceMembers")>()),
  scheduleMemberSync: (spaceId: string) => h.call("scheduleMemberSync", spaceId),
}));
vi.mock("@/store/thunks/spaceConfigSync", async (orig) => ({
  ...(await orig<typeof import("@/store/thunks/spaceConfigSync")>()),
  scheduleSpaceConfigSync: (spaceId: string, changes: unknown) => h.call("scheduleSpaceConfigSync", spaceId, changes),
}));
vi.mock("@/features/spaces/nip29SpaceSync", async (orig) => ({
  ...(await orig<typeof import("@/features/spaces/nip29SpaceSync")>()),
  applyNativeGroupEvent: (e: unknown) => (h.call("applyNativeGroupEvent", e), h.native.group),
  applyNativeLayoutEvent: (e: unknown) => (h.call("applyNativeLayoutEvent", e), h.native.layout),
  applyNativeRelaySetEvent: (e: unknown) => (h.call("applyNativeRelaySetEvent", e), h.native.relaySet),
}));
vi.mock("@/features/music/savedVersionSync", async (orig) => ({
  ...(await orig<typeof import("@/features/music/savedVersionSync")>()),
  notifyMusicUpdate: (addr: string) => h.call("notifyMusicUpdate", addr),
}));
vi.mock("@/lib/nostr/friendRequest", () => ({
  acceptFriendRequestAction: async (pk: string) => h.call("acceptFriendRequestAction", pk),
}));
vi.mock("@/lib/nostr/follow", () => ({
  followUser: async (pk: string) => h.call("followUser", pk),
  unfollowUser: async () => {},
}));
vi.mock("@/lib/nostr/dmSignals", () => ({
  queueDeliveredReceipt: (partner: string, rumorId: string) => h.call("queueDeliveredReceipt", partner, rumorId),
}));
vi.mock("@/lib/webrtc/e2ee/mediaKeyInbox", async (orig) => ({
  ...(await orig<typeof import("@/lib/webrtc/e2ee/mediaKeyInbox")>()),
  deliverMediaKey: (sender: string, _env: unknown, wrapId: string) => h.call("deliverMediaKey", sender, wrapId),
}));

import { createEventPipeline, type EventPipelineDeps } from "../eventPipeline";
import { GiftWrapRejectedError } from "@ishtarservices/core";
import { store, resetAll } from "@/store";
import type { AppDispatch } from "@/store";
import { login, setFollowList, setMuteList } from "@/store/slices/identitySlice";
import { setSpaces, setChannels, setActiveSpace } from "@/store/slices/spacesSlice";
import { eventsSelectors } from "@/store/slices/eventsSlice";
import type { NostrEvent } from "@/types/nostr";
import type { Space, SpaceChannel } from "@/types/space";

const NOW_MS = Date.parse("2026-01-01T00:00:00Z");
const NOW = NOW_MS / 1000;
const WS = "wss://relay.example";
const SIG = "0".repeat(128);
const hex64 = (n: number) => n.toString(16).padStart(64, "0");

const ME = hex64(0xa11);
const AUTHOR = hex64(0xb0b);
const OTHER = hex64(0xc4f);
const SPACE = "space1";

let seq = 0;
function ev(kind: number, over: Partial<NostrEvent> = {}): NostrEvent {
  seq += 1;
  return { id: hex64(seq), pubkey: AUTHOR, created_at: NOW - 60, kind, tags: [], content: "", sig: SIG, ...over };
}

interface Harness {
  pipeline: ReturnType<typeof createEventPipeline>;
  /** The handler the pipeline registered with the decrypt queue. */
  wrapHandler: (event: NostrEvent, receivedAt?: number) => Promise<void> | void;
  verify: { next: Array<boolean | Error | Promise<boolean>> };
  queueAccepts: { value: boolean };
}

function harness(): Harness {
  const verify = { next: [] as Array<boolean | Error | Promise<boolean>> };
  const queueAccepts = { value: true };
  let wrapHandler: Harness["wrapHandler"] = () => {
    throw new Error("no handler registered");
  };
  const deps: EventPipelineDeps = {
    dispatch: ((a: Parameters<AppDispatch>[0]) => store.dispatch(a)) as AppDispatch,
    getState: () => store.getState(),
    verifier: {
      verify: async (e) => {
        h.call("verify", e);
        const r = verify.next.shift();
        if (r instanceof Error) throw r;
        return r === undefined ? true : r;
      },
    },
    persistence: {
      putEvent: async (e) => h.call("persist.putEvent", e),
      deleteEvent: async (id) => h.call("persist.deleteEvent", id),
      deleteAddressableEvent: async (kind, pubkey, d) => h.call("persist.deleteAddressableEvent", kind, pubkey, d),
    },
    profileCache: { handleProfileEvent: (e, relay) => h.call("profileCache.handleProfileEvent", e, relay) },
    decryptQueue: {
      submit: (e) => {
        h.call("decryptQueue.submit", e);
        return queueAccepts.value;
      },
      clear: () => h.call("decryptQueue.clear"),
      setHandler: (fn) => {
        h.call("decryptQueue.setHandler", fn);
        wrapHandler = fn as Harness["wrapHandler"];
      },
    },
  };
  const pipeline = createEventPipeline(deps);
  return { pipeline, get wrapHandler() { return wrapHandler; }, verify, queueAccepts };
}

/** Everything recorded since the last call, then cleared. */
function take(): string[] {
  const out = h.trace.slice();
  h.trace.length = 0;
  return out;
}

function space(over: Partial<Space> = {}): Space {
  return {
    id: SPACE, hostRelay: WS, name: "S", isPrivate: false, adminPubkeys: [], memberPubkeys: [AUTHOR],
    feedPubkeys: [], mode: "read-write", creatorPubkey: ME, createdAt: 0, ...over,
  };
}
function channel(id: string, type: SpaceChannel["type"], over: Partial<SpaceChannel> = {}): SpaceChannel {
  return {
    id, spaceId: SPACE, type, label: id, position: 0, isDefault: false, adminOnly: false,
    slowModeSeconds: 0, feedMode: "all", ...over,
  };
}

let dispatchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  seq = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  store.dispatch(resetAll());
  store.dispatch(login({ pubkey: ME, signerType: "tauri_keystore" }));
  h.native.group = h.native.layout = h.native.relaySet = false;
  h.unwrap = async () => {
    throw new Error("no rumor queued");
  };
  const real = store.dispatch.bind(store);
  dispatchSpy = vi.spyOn(store, "dispatch").mockImplementation(((a: { type?: string; payload?: unknown }) => {
    h.trace.push(typeof a === "function" ? "dispatch <thunk>" : `dispatch ${a.type} ${h.fmt(a.payload)}`.trimEnd());
    return real(a as never);
  }) as never);
  h.trace.length = 0;
});

afterEach(() => {
  dispatchSpy.mockRestore();
  store.dispatch(resetAll());
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("pipeline stages — validate → dedup → verify → dispatch", () => {
  it("registers the gift-wrap handler with the decrypt queue when it is built, and nothing else", () => {
    harness();
    expect(take()).toMatchInlineSnapshot(`
      [
        "decryptQueue.setHandler(<fn>)",
      ]
    `);
  });

  it("drops a structurally invalid event before dedup and verification", async () => {
    const { pipeline } = harness();
    take();
    await pipeline.processIncomingEvent({ id: "short", kind: 1 }, "local");
    await pipeline.processIncomingEvent(null, "local");
    await pipeline.processIncomingEvent({ ...ev(1), created_at: NOW + 901 }, "local");
    expect(take()).toEqual([]);
  });

  it("a valid event from a synthetic source: verify, then one flushed batch, entities before indices", async () => {
    const { pipeline } = harness();
    take();
    await pipeline.processIncomingEvent(ev(1, { content: "hi" }), "local");
    expect(take()).toMatchInlineSnapshot(`
      [
        "verify("event:#1")",
        "dispatch events/addEvents ["event:#1"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexNotes [{"pubkey":"#b0b","eventId":"#1"}]",
      ]
    `);
  });

  it("a duplicate is dropped at dedup: it is not verified or dispatched again", async () => {
    const { pipeline } = harness();
    const e = ev(1);
    await pipeline.processIncomingEvent(e, "local");
    take();
    await pipeline.processIncomingEvent(e, "wss://other.relay");
    expect(take()).toEqual([]);
  });

  it("marks an event seen before verification resolves, so a concurrent copy is not verified twice", async () => {
    const { pipeline, verify } = harness();
    take();
    let release!: (ok: boolean) => void;
    verify.next.push(new Promise<boolean>((r) => (release = r)));
    const e = ev(1);
    const first = pipeline.processIncomingEvent(e, "local");
    const second = pipeline.processIncomingEvent(e, "local");
    release(true);
    await Promise.all([first, second]);
    expect(take().filter((l) => l.startsWith("verify("))).toHaveLength(1);
  });

  it("a failed verification dispatches nothing and unmarks the event, so another relay's copy is verified again", async () => {
    const { pipeline, verify } = harness();
    take();
    const e = ev(1);
    verify.next.push(false);
    await pipeline.processIncomingEvent(e, "local");
    expect(take()).toMatchInlineSnapshot(`
      [
        "verify("event:#1")",
      ]
    `);
    await pipeline.processIncomingEvent(e, "local");
    expect(take()).toMatchInlineSnapshot(`
      [
        "verify("event:#1")",
        "dispatch events/addEvents ["event:#1"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexNotes [{"pubkey":"#b0b","eventId":"#1"}]",
      ]
    `);
  });

  it("a verifier error (timeout / worker crash) also unmarks for a retry", async () => {
    const { pipeline, verify } = harness();
    take();
    const e = ev(1);
    verify.next.push(new Error("verify timeout"));
    await pipeline.processIncomingEvent(e, "local");
    expect(take()).toMatchInlineSnapshot(`
      [
        "verify("event:#1")",
      ]
    `);
    await pipeline.processIncomingEvent(e, "local");
    expect(take().some((l) => l.startsWith("dispatch events/addEvents"))).toBe(true);
  });

  it("kind:0 goes to the profile cache after the store, addressable kinds are persisted, then indexed", async () => {
    const { pipeline } = harness();
    take();
    await pipeline.processIncomingEvent(ev(0, { content: "{}" }), WS);
    await pipeline.processIncomingEvent(ev(30023, { tags: [["d", "post"]] }), "local");
    expect(take()).toMatchInlineSnapshot(`
      [
        "verify("event:#1")",
        "profileCache.handleProfileEvent("event:#1", "wss://relay.example")",
        "verify("event:#2")",
        "persist.putEvent("event:#2")",
        "dispatch events/addEvents ["event:#1","event:#2"]",
        "dispatch relays/incrementCounts {"wss://relay.example":1,"local":1}",
        "dispatch events/indexLongForms [{"contextId":"global","eventId":"#2"}]",
      ]
    `);
  });

  it("a kind with no indexEvent case is still stored as an entity, with no index", async () => {
    const { pipeline } = harness();
    take();
    await pipeline.processIncomingEvent(ev(1063), "local");
    expect(take()).toMatchInlineSnapshot(`
      [
        "verify("event:#1")",
        "dispatch events/addEvents ["event:#1"]",
        "dispatch relays/incrementCounts {"local":1}",
      ]
    `);
  });

  it("re-delivered deleted notes are rejected after verification", async () => {
    const { pipeline } = harness();
    const note = ev(1);
    await pipeline.processIncomingEvent(note, "local");
    await pipeline.processIncomingEvent(ev(5, { tags: [["e", note.id]] }), "local");
    pipeline.resetEventPipelineCaches(); // the LRU forgets; the store's deleted-id record does not
    take();
    await pipeline.processIncomingEvent(note, "local");
    expect(take()).toMatchInlineSnapshot(`
      [
        "verify("event:#1")",
      ]
    `);
  });

  it("a deleted address rejects older copies and accepts a re-publish newer than the deletion", async () => {
    const { pipeline } = harness();
    const addr = `31683:${AUTHOR}:song`;
    const old = ev(31683, { tags: [["d", "song"], ["title", "Song"]], created_at: NOW - 500 });
    await pipeline.processIncomingEvent(old, "local");
    await pipeline.processIncomingEvent(ev(5, { tags: [["a", addr]], created_at: NOW - 400 }), "local");
    pipeline.resetEventPipelineCaches();
    take();
    await pipeline.processIncomingEvent(old, "local");
    expect(take()).toMatchInlineSnapshot(`
      [
        "verify("event:#1")",
      ]
    `);
    await pipeline.processIncomingEvent(ev(31683, { tags: [["d", "song"], ["title", "Song v2"]], created_at: NOW - 300 }), "local");
    expect(take().some((l) => l.startsWith("dispatch music/addTrack"))).toBe(true);
  });

  it("a pending deletion is resolved against the target's author when the target arrives", async () => {
    const { pipeline } = harness();
    const note = ev(1);
    const chat = ev(9, { tags: [["h", SPACE]] });
    const foreign = ev(1);
    await pipeline.processIncomingEvent(ev(5, { tags: [["e", note.id], ["e", chat.id]] }), "local");
    await pipeline.processIncomingEvent(ev(5, { pubkey: OTHER, tags: [["e", foreign.id]] }), "local");
    take();
    await pipeline.processIncomingEvent(note, "local");
    await pipeline.processIncomingEvent(chat, "local");
    await pipeline.processIncomingEvent(foreign, "local");
    expect(take()).toMatchInlineSnapshot(`
      [
        "verify("event:#1")",
        "dispatch events/clearPendingDeletion "#1"",
        "dispatch events/trackDeletedNote "#1"",
        "persist.deleteEvent("#1")",
        "verify("event:#2")",
        "dispatch events/clearPendingDeletion "#2"",
        "dispatch events/hideMessage "#2"",
        "persist.deleteEvent("#2")",
        "verify("event:#3")",
        "dispatch events/clearPendingDeletion "#3"",
        "dispatch events/addEvents ["event:#3"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexNotes [{"pubkey":"#b0b","eventId":"#3"}]",
      ]
    `);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("burst batching and flush", () => {
  it("relay events wait 50 ms; a chat event pulls the pending flush in to 16 ms", async () => {
    const { pipeline } = harness();
    take();
    await pipeline.processIncomingEvent(ev(1), WS);
    vi.advanceTimersByTime(49);
    expect(take().filter((l) => l.startsWith("dispatch"))).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(take().some((l) => l.startsWith("dispatch events/addEvents"))).toBe(true);

    await pipeline.processIncomingEvent(ev(1), WS);
    vi.advanceTimersByTime(20);
    await pipeline.processIncomingEvent(ev(9, { tags: [["h", SPACE]] }), WS);
    vi.advanceTimersByTime(15);
    expect(take().filter((l) => l.startsWith("dispatch"))).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(take().filter((l) => l.startsWith("dispatch events/addEvents"))).toHaveLength(1);
  });

  it("a later non-chat event does not push an already scheduled chat flush back", async () => {
    const { pipeline } = harness();
    await pipeline.processIncomingEvent(ev(9, { tags: [["h", SPACE]] }), WS);
    vi.advanceTimersByTime(10);
    await pipeline.processIncomingEvent(ev(1), WS);
    take();
    vi.advanceTimersByTime(6);
    expect(take().filter((l) => l.startsWith("dispatch events/addEvents"))).toHaveLength(1);
  });

  it("flushes one coalesced action per index, in a fixed order, entities first", async () => {
    store.dispatch(setSpaces([space()]));
    store.dispatch(setChannels({ spaceId: SPACE, channels: [channel("general", "chat", { isDefault: true })] }));
    const { pipeline } = harness();
    const root = ev(1);
    take();
    const burst: NostrEvent[] = [
      root,
      ev(1, { tags: [["e", root.id, "", "root"], ["q", hex64(0x999)]] }),
      ev(7, { tags: [["e", root.id]], content: "+" }),
      ev(1018, { tags: [["e", hex64(0x777)], ["response", "a"]] }),
      ev(6, { tags: [["e", root.id]] }),
      ev(9, { tags: [["h", SPACE]] }),
      ev(22, {}),
      ev(30023, { tags: [["d", "a"]] }),
      ev(30311, { tags: [["d", "l"]] }),
      ev(31683, { tags: [["d", "t"], ["title", "T"]] }),
      ev(33123, { tags: [["d", "al"], ["title", "A"]] }),
    ];
    for (const e of burst) await pipeline.processIncomingEvent(e, WS);
    expect(take().filter((l) => l.startsWith("dispatch")).map((l) => l.split(" ")[1])).toMatchInlineSnapshot(`
      [
        "notifications/incrementUnread",
        "music/addTrack",
        "music/indexTrackByArtist",
        "music/addAlbum",
        "music/indexAlbumByArtist",
      ]
    `);
    vi.advanceTimersByTime(50);
    expect(take().map((l) => l.split(" ")[1])).toMatchInlineSnapshot(`
      [
        "events/addEvents",
        "relays/incrementCounts",
        "events/indexNotes",
        "reactions/addReactions",
        "polls/addPollVotes",
        "events/indexReplies",
        "events/indexReposts",
        "events/indexRepostsByAuthor",
        "events/indexQuotes",
        "events/indexChatMessages",
        "events/indexReels",
        "events/indexLongForms",
        "events/indexLiveStreams",
        "events/indexMusicTracks",
        "events/indexMusicAlbums",
        "events/indexSpaceFeeds",
        "feed/trackFeedTimestamps",
      ]
    `);
  });

  it("flushEventPipeline applies the buffer now and cancels the timer", async () => {
    const { pipeline } = harness();
    await pipeline.processIncomingEvent(ev(1), WS);
    take();
    pipeline.flushEventPipeline();
    expect(take().map((l) => l.split(" ")[1])).toMatchInlineSnapshot(`
      [
        "events/addEvents",
        "relays/incrementCounts",
        "events/indexNotes",
      ]
    `);
    vi.advanceTimersByTime(1000);
    expect(take()).toEqual([]);
  });

  it("resetEventPipelineCaches drops the buffer, the timer, the dedup LRU and the queued wraps", async () => {
    const { pipeline } = harness();
    const e = ev(1);
    await pipeline.processIncomingEvent(e, WS);
    take();
    pipeline.resetEventPipelineCaches();
    vi.advanceTimersByTime(1000);
    expect(take()).toMatchInlineSnapshot(`
      [
        "decryptQueue.clear()",
      ]
    `);
    expect(eventsSelectors.selectById(store.getState().events, e.id)).toBeUndefined();
    // The LRU was cleared: the same event is processed again.
    await pipeline.processIncomingEvent(e, "local");
    expect(eventsSelectors.selectById(store.getState().events, e.id)).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("indexEvent routing, kind by kind", () => {
  /** Run events through one pipeline from a synthetic source; return the trace. */
  async function route(...events: NostrEvent[]): Promise<string[]> {
    const { pipeline } = harness();
    take();
    for (const e of events) await pipeline.processIncomingEvent(e, "local");
    return take().filter((l) => !l.startsWith("verify("));
  }

  it("kind 1 note: by author; a reply indexes under root and parent; a q tag indexes a quote", async () => {
    const rootId = hex64(0x100);
    const replyId = hex64(0x101);
    expect(
      await route(
        ev(1),
        ev(1, { tags: [["e", rootId, "", "root"], ["e", replyId, "", "reply"]] }),
        ev(1, { tags: [["q", hex64(0x102)]] }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "dispatch events/addEvents ["event:#1"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexNotes [{"pubkey":"#b0b","eventId":"#1"}]",
        "dispatch events/addEvents ["event:#2"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexNotes [{"pubkey":"#b0b","eventId":"#2"}]",
        "dispatch events/indexReplies [{"parentEventId":"#100","eventId":"#2"},{"parentEventId":"#101","eventId":"#2"}]",
        "dispatch events/addEvents ["event:#3"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexNotes [{"pubkey":"#b0b","eventId":"#3"}]",
        "dispatch events/indexQuotes [{"targetEventId":"#102","eventId":"#3"}]",
      ]
    `);
  });

  it("kind 7 reaction: folded into the aggregate under its last e tag, never stored", async () => {
    expect(
      await route(
        ev(7, { tags: [["e", hex64(0x100)], ["e", hex64(0x101)]], content: "🔥" }),
        ev(7, { tags: [["p", OTHER]], content: "+" }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch reactions/addReactions [{"targetEventId":"#101","reactor":"#b0b","content":"🔥","eventId":"#1"}]",
        "dispatch relays/incrementCounts {"local":1}",
      ]
    `);
  });

  it("kind 6 repost: by target and by author", async () => {
    expect(await route(ev(6, { tags: [["e", hex64(0x100)]] }), ev(6))).toMatchInlineSnapshot(`
      [
        "dispatch events/addEvents ["event:#1"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexReposts [{"targetEventId":"#100","eventId":"#1"}]",
        "dispatch events/indexRepostsByAuthor [{"pubkey":"#b0b","eventId":"#1"}]",
        "dispatch events/addEvents ["event:#2"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexRepostsByAuthor [{"pubkey":"#b0b","eventId":"#2"}]",
      ]
    `);
  });

  it("kind 9 chat: channel tag, default chat channel, space fallback, and edits", async () => {
    const original = ev(9, { tags: [["h", SPACE], ["channel", "ch1"]] });
    const noChannels = await route(
      original,
      ev(9, { tags: [["h", SPACE]] }),
      ev(9, { tags: [] }),
      ev(9, { tags: [["h", SPACE], ["e", original.id, "", "edit"]] }),
      ev(9, { pubkey: OTHER, tags: [["h", SPACE], ["e", original.id, "", "edit"]] }),
    );
    expect(noChannels).toMatchInlineSnapshot(`
      [
        "dispatch events/addEvents ["event:#1"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexChatMessages [{"groupId":"space1:ch1","eventId":"#1"}]",
        "dispatch feed/trackFeedTimestamps [{"contextId":"space1:ch1","createdAt":1767225540}]",
        "dispatch events/addEvents ["event:#2"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexChatMessages [{"groupId":"space1","eventId":"#2"}]",
        "dispatch feed/trackFeedTimestamps [{"contextId":"space1","createdAt":1767225540}]",
        "dispatch events/addEvents ["event:#3"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/addEvents ["event:#4"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexEditedMessage {"originalId":"#1","editEventId":"#4"}",
        "dispatch events/addEvents ["event:#5"]",
        "dispatch relays/incrementCounts {"local":1}",
      ]
    `);

    store.dispatch(setSpaces([space()]));
    store.dispatch(
      setChannels({ spaceId: SPACE, channels: [channel("lobby", "chat"), channel("main", "chat", { isDefault: true })] }),
    );
    expect(await route(ev(9, { tags: [["h", SPACE]] }))).toMatchInlineSnapshot(`
      [
        "dispatch notifications/incrementUnread {"spaceId":"space1","channelId":"space1:lobby"}",
        "dispatch events/addEvents ["event:#6"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexChatMessages [{"groupId":"space1:main","eventId":"#6"}]",
        "dispatch feed/trackFeedTimestamps [{"contextId":"space1:main","createdAt":1767225540}]",
      ]
    `);
  });

  it("kind 1068 poll: h-tagged into the chat timeline, bare onto the notes surfaces; kind 1018 vote folds", async () => {
    const poll = ev(1068, { tags: [["option", "a", "A"], ["option", "b", "B"]] });
    expect(
      await route(
        ev(1068, { tags: [["h", SPACE], ["channel", "ch1"], ["option", "a", "A"]] }),
        poll,
        ev(1018, { tags: [["e", poll.id], ["response", "a"]] }),
        ev(1018, { tags: [] }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "dispatch events/addEvents ["event:#2"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexChatMessages [{"groupId":"space1:ch1","eventId":"#2"}]",
        "dispatch feed/trackFeedTimestamps [{"contextId":"space1:ch1","createdAt":1767225540}]",
        "dispatch events/addEvents ["event:#1"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexNotes [{"pubkey":"#b0b","eventId":"#1"}]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch polls/addPollVotes [{"pollId":"#1","voter":"#b0b","optionIds":["a"],"createdAt":1767225540,"eventId":"#3"}]",
        "dispatch relays/incrementCounts {"local":1}",
      ]
    `);
  });

  it("kinds 22 / 34236 reels, 30023 long-form, 30311 live streams: global or by h tag", async () => {
    expect(
      await route(
        ev(22),
        ev(34236, { tags: [["d", "v"], ["h", SPACE]] }),
        ev(30023, { tags: [["d", "p"]] }),
        ev(30023, { tags: [["d", "q"], ["h", SPACE]] }),
        ev(30311, { tags: [["d", "s"]] }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "dispatch events/addEvents ["event:#1"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexReels [{"contextId":"global","eventId":"#1"}]",
        "persist.putEvent("event:#2")",
        "dispatch events/addEvents ["event:#2"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexReels [{"contextId":"space1","eventId":"#2"}]",
        "persist.putEvent("event:#3")",
        "dispatch events/addEvents ["event:#3"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexLongForms [{"contextId":"global","eventId":"#3"}]",
        "persist.putEvent("event:#4")",
        "dispatch events/addEvents ["event:#4"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexLongForms [{"contextId":"space1","eventId":"#4"}]",
        "persist.putEvent("event:#5")",
        "dispatch events/addEvents ["event:#5"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexLiveStreams [{"contextId":"global","eventId":"#5"}]",
      ]
    `);
  });

  it("kind 31683 music track: indexed, parsed, and fanned out to the artist / featured / collaborator / album indices", async () => {
    expect(
      await route(
        ev(31683, { tags: [["d", "plain"], ["title", "Plain"]] }),
        ev(31683, {
          tags: [
            ["d", "rich"], ["title", "Rich"], ["h", SPACE],
            ["p", OTHER, "artist"], ["p", ME, "featured"], ["p", hex64(0xc011), "collaborator"],
            ["a", `33123:${AUTHOR}:lp`],
          ],
        }),
        ev(31683, { tags: [["d", "named"], ["title", "Named"], ["artist", "Some Band"]] }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "persist.putEvent("event:#1")",
        "dispatch music/addTrack {"addressableId":"31683:#b0b:plain"}",
        "dispatch music/indexTrackByArtist {"pubkey":"#b0b","addressableId":"31683:#b0b:plain"}",
        "notifyMusicUpdate("31683:#b0b:plain")",
        "dispatch events/addEvents ["event:#1"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexMusicTracks [{"contextId":"global","eventId":"#1"}]",
        "persist.putEvent("event:#2")",
        "dispatch music/addTrack {"addressableId":"31683:#b0b:rich"}",
        "dispatch music/indexTrackByArtistName {"normalizedName":"#c4f","addressableId":"31683:#b0b:rich"}",
        "dispatch music/indexTrackByArtist {"pubkey":"#c4f","addressableId":"31683:#b0b:rich"}",
        "dispatch music/indexTrackByArtist {"pubkey":"#a11","addressableId":"31683:#b0b:rich"}",
        "dispatch music/indexTrackByArtist {"pubkey":"#c011","addressableId":"31683:#b0b:rich"}",
        "dispatch music/indexTrackByAlbum {"albumAddrId":"33123:#b0b:lp","trackAddrId":"31683:#b0b:rich"}",
        "notifyMusicUpdate("31683:#b0b:rich")",
        "dispatch notifications/addNotification {"id":"collab-31683:#b0b:rich-v1767225540","type":"invite","title":"New collaboration","body":"00000000... added you to \\"Rich\\" track","actorPubkey":"#b0b","contextId":"31683:#b0b:rich","timestamp":1767225600000}",
        "dispatch events/addEvents ["event:#2"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexMusicTracks [{"contextId":"space1","eventId":"#2"}]",
        "persist.putEvent("event:#3")",
        "dispatch music/addTrack {"addressableId":"31683:#b0b:named"}",
        "dispatch music/indexTrackByArtistName {"normalizedName":"some band","addressableId":"31683:#b0b:named"}",
        "notifyMusicUpdate("31683:#b0b:named")",
        "dispatch events/addEvents ["event:#3"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexMusicTracks [{"contextId":"global","eventId":"#3"}]",
      ]
    `);
  });

  it("kind 31683 private track: decrypt is attempted and a failure is swallowed", async () => {
    expect(
      await route(ev(31683, { tags: [["d", "priv"], ["visibility", "private"]], content: "ciphertext" })),
    ).toMatchInlineSnapshot(`
      [
        "persist.putEvent("event:#1")",
        "dispatch music/addTrack {"addressableId":"31683:#b0b:priv"}",
        "dispatch music/indexTrackByArtist {"pubkey":"#b0b","addressableId":"31683:#b0b:priv"}",
        "notifyMusicUpdate("31683:#b0b:priv")",
        "dispatch events/addEvents ["event:#1"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexMusicTracks [{"contextId":"global","eventId":"#1"}]",
      ]
    `);
  });

  it("kind 33123 album, 30119 playlist, 31686 annotation", async () => {
    expect(
      await route(
        ev(33123, { tags: [["d", "lp"], ["title", "LP"]] }),
        ev(33123, { tags: [["d", "lp2"], ["title", "LP2"], ["p", OTHER, "artist"], ["p", ME, "collaborator"]] }),
        ev(30119, { tags: [["d", "pl"], ["title", "Mix"], ["a", `31683:${AUTHOR}:plain`]] }),
        ev(31686, { tags: [["d", "n1"], ["a", `31683:${AUTHOR}:plain`]], content: "nice" }),
        ev(31686, { tags: [] }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "persist.putEvent("event:#1")",
        "dispatch music/addAlbum {"addressableId":"33123:#b0b:lp"}",
        "dispatch music/indexAlbumByArtist {"pubkey":"#b0b","addressableId":"33123:#b0b:lp"}",
        "notifyMusicUpdate("33123:#b0b:lp")",
        "dispatch events/addEvents ["event:#1"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexMusicAlbums [{"contextId":"global","eventId":"#1"}]",
        "persist.putEvent("event:#2")",
        "dispatch music/addAlbum {"addressableId":"33123:#b0b:lp2"}",
        "dispatch music/indexAlbumByArtist {"pubkey":"#b0b","addressableId":"33123:#b0b:lp2"}",
        "dispatch music/indexAlbumByArtist {"pubkey":"#c4f","addressableId":"33123:#b0b:lp2"}",
        "dispatch music/indexAlbumByArtist {"pubkey":"#a11","addressableId":"33123:#b0b:lp2"}",
        "notifyMusicUpdate("33123:#b0b:lp2")",
        "dispatch notifications/addNotification {"id":"collab-33123:#b0b:lp2-v1767225540","type":"invite","title":"New collaboration","body":"00000000... added you to \\"LP2\\" project","actorPubkey":"#b0b","contextId":"33123:#b0b:lp2","timestamp":1767225600000}",
        "dispatch events/addEvents ["event:#2"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/indexMusicAlbums [{"contextId":"global","eventId":"#2"}]",
        "persist.putEvent("event:#3")",
        "dispatch music/addPlaylist {"addressableId":"30119:#b0b:pl"}",
        "dispatch events/addEvents ["event:#3"]",
        "dispatch relays/incrementCounts {"local":1}",
        "persist.putEvent("event:#4")",
        "dispatch music/addAnnotation {"addressableId":"31686:#b0b:n1"}",
        "dispatch events/addEvents ["event:#4"]",
        "dispatch relays/incrementCounts {"local":1}",
        "persist.putEvent("event:#5")",
        "dispatch events/addEvents ["event:#5"]",
        "dispatch relays/incrementCounts {"local":1}",
      ]
    `);
  });

  it("kind 5 deletion by address: only the author's own, only copies older than the deletion", async () => {
    const track = ev(31683, { tags: [["d", "t"], ["title", "T"]], created_at: NOW - 500 });
    const album = ev(33123, { tags: [["d", "a"], ["title", "A"]], created_at: NOW - 500 });
    const playlist = ev(30119, { tags: [["d", "p"], ["title", "P"]], created_at: NOW - 500 });
    const note = ev(31686, { tags: [["d", "n"], ["a", `31683:${AUTHOR}:t`]], content: "x", created_at: NOW - 500 });
    const newer = ev(31683, { tags: [["d", "new"], ["title", "N"]], created_at: NOW - 10 });
    const { pipeline } = harness();
    for (const e of [track, album, playlist, note, newer]) await pipeline.processIncomingEvent(e, "local");
    take();
    await pipeline.processIncomingEvent(
      ev(5, {
        created_at: NOW - 100,
        tags: [
          ["a", `31683:${AUTHOR}:t`],
          ["a", `33123:${AUTHOR}:a`],
          ["a", `30119:${AUTHOR}:p`],
          ["a", `31686:${AUTHOR}:n`],
          ["a", `31683:${AUTHOR}:new`],
          ["a", `31683:${OTHER}:theirs`],
        ],
      }),
      "local",
    );
    expect(take().filter((l) => !l.startsWith("verify("))).toMatchInlineSnapshot(`
      [
        "dispatch events/addEvents ["event:#6"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/trackDeletedAddr {"addr":"31683:#b0b:t","deletedAt":1767225500}",
        "persist.deleteAddressableEvent(31683, "#b0b", "t")",
        "dispatch music/removeTrack "31683:#b0b:t"",
        "dispatch events/trackDeletedAddr {"addr":"33123:#b0b:a","deletedAt":1767225500}",
        "persist.deleteAddressableEvent(33123, "#b0b", "a")",
        "dispatch music/removeAlbum "33123:#b0b:a"",
        "dispatch events/trackDeletedAddr {"addr":"30119:#b0b:p","deletedAt":1767225500}",
        "persist.deleteAddressableEvent(30119, "#b0b", "p")",
        "dispatch music/removePlaylist "30119:#b0b:p"",
        "dispatch events/trackDeletedAddr {"addr":"31686:#b0b:n","deletedAt":1767225500}",
        "dispatch music/removeAnnotation {"targetRef":"31683:#b0b:t","addressableId":"31686:#b0b:n"}",
        "dispatch events/trackDeletedAddr {"addr":"31683:#b0b:new","deletedAt":1767225500}",
        "persist.putEvent("event:#6")",
      ]
    `);
  });

  it("kind 5 deletion by id: chat, chat poll, notes poll, note, repost; unknown targets become pending; non-authors are ignored", async () => {
    const chat = ev(9, { tags: [["h", SPACE], ["channel", "ch1"]] });
    const chatPoll = ev(1068, { tags: [["h", SPACE], ["option", "a", "A"]] });
    const notePoll = ev(1068, { tags: [["option", "a", "A"]] });
    const note = ev(1);
    const repost = ev(6, { tags: [["e", hex64(0x100)]] });
    const addressable = ev(30023, { tags: [["d", "post"]] });
    const theirs = ev(1, { pubkey: OTHER });
    const { pipeline } = harness();
    for (const e of [chat, chatPoll, notePoll, note, repost, addressable, theirs]) {
      await pipeline.processIncomingEvent(e, "local");
    }
    take();
    await pipeline.processIncomingEvent(
      ev(5, {
        tags: [
          ["e", chat.id], ["e", chatPoll.id], ["e", notePoll.id], ["e", note.id], ["e", repost.id],
          ["e", addressable.id], ["e", theirs.id], ["e", hex64(0xdead)],
        ],
      }),
      "local",
    );
    expect(take().filter((l) => !l.startsWith("verify("))).toMatchInlineSnapshot(`
      [
        "dispatch events/addEvents ["event:#8"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch reactions/removeReactionByEventId {"eventId":"#1","byPubkey":"#b0b"}",
        "dispatch polls/removeVoteByEventId {"eventId":"#1","byPubkey":"#b0b"}",
        "persist.deleteEvent("#1")",
        "dispatch events/removeChatMessage {"contextId":"space1:ch1","eventId":"#1"}",
        "dispatch events/hideMessage "#1"",
        "dispatch events/removeEvent "#1"",
        "dispatch reactions/removeReactionByEventId {"eventId":"#2","byPubkey":"#b0b"}",
        "dispatch polls/removeVoteByEventId {"eventId":"#2","byPubkey":"#b0b"}",
        "persist.deleteEvent("#2")",
        "dispatch events/removeChatMessage {"contextId":"space1","eventId":"#2"}",
        "dispatch events/hideMessage "#2"",
        "dispatch events/removeEvent "#2"",
        "dispatch events/trackDeletedNote "#2"",
        "dispatch polls/removePoll "#2"",
        "dispatch reactions/removeReactionByEventId {"eventId":"#3","byPubkey":"#b0b"}",
        "dispatch polls/removeVoteByEventId {"eventId":"#3","byPubkey":"#b0b"}",
        "persist.deleteEvent("#3")",
        "dispatch events/removeNote {"pubkey":"#b0b","eventId":"#3"}",
        "dispatch events/removeEvent "#3"",
        "dispatch events/trackDeletedNote "#3"",
        "dispatch polls/removePoll "#3"",
        "dispatch reactions/removeReactionByEventId {"eventId":"#4","byPubkey":"#b0b"}",
        "dispatch polls/removeVoteByEventId {"eventId":"#4","byPubkey":"#b0b"}",
        "persist.deleteEvent("#4")",
        "dispatch events/removeNote {"pubkey":"#b0b","eventId":"#4"}",
        "dispatch events/removeEvent "#4"",
        "dispatch events/trackDeletedNote "#4"",
        "dispatch reactions/removeReactionByEventId {"eventId":"#5","byPubkey":"#b0b"}",
        "dispatch polls/removeVoteByEventId {"eventId":"#5","byPubkey":"#b0b"}",
        "persist.deleteEvent("#5")",
        "dispatch events/removeRepost {"pubkey":"#b0b","eventId":"#5"}",
        "dispatch events/removeEvent "#5"",
        "dispatch events/trackDeletedNote "#5"",
        "dispatch reactions/removeReactionByEventId {"eventId":"#6","byPubkey":"#b0b"}",
        "dispatch polls/removeVoteByEventId {"eventId":"#6","byPubkey":"#b0b"}",
        "dispatch reactions/removeReactionByEventId {"eventId":"#7","byPubkey":"#b0b"}",
        "dispatch polls/removeVoteByEventId {"eventId":"#7","byPubkey":"#b0b"}",
        "dispatch reactions/removeReactionByEventId {"eventId":"#dead","byPubkey":"#b0b"}",
        "dispatch polls/removeVoteByEventId {"eventId":"#dead","byPubkey":"#b0b"}",
        "dispatch events/trackPendingDeletion {"eventId":"#dead","deleter":"#b0b"}",
        "persist.putEvent("event:#8")",
      ]
    `);
  });

  it("kinds 30030 / 10030 emoji: sets are stored (and tracked per space); the user list only when it is ours", async () => {
    expect(
      await route(
        ev(30030, { tags: [["d", "pack"], ["emoji", "wave", "https://e.test/w.png"]] }),
        ev(30030, { tags: [["d", "spacepack"], ["h", SPACE], ["emoji", "yo", "https://e.test/y.png"]] }),
        ev(10030, { tags: [["emoji", "x", "https://e.test/x.png"]] }),
        ev(10030, { pubkey: ME, tags: [["emoji", "mine", "https://e.test/m.png"]] }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "persist.putEvent("event:#1")",
        "dispatch emoji/addEmojiSet {"addressableId":"30030:#b0b:pack"}",
        "dispatch events/addEvents ["event:#1"]",
        "dispatch relays/incrementCounts {"local":1}",
        "persist.putEvent("event:#2")",
        "dispatch emoji/addEmojiSet {"addressableId":"30030:#b0b:spacepack"}",
        "dispatch emoji/setSpaceEmojiSets {"spaceId":"space1","setIds":["30030:#b0b:spacepack"]}",
        "dispatch events/addEvents ["event:#2"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/addEvents ["event:#3"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch emoji/setUserEmojis [{"shortcode":"mine","url":"https://e.test/m.png"}]",
        "dispatch events/addEvents ["event:#4"]",
        "dispatch relays/incrementCounts {"local":1}",
      ]
    `);
  });

  it("kind 30078: relay-set overlay first, layout overlay only when that declined", async () => {
    expect(await route(ev(30078, { tags: [["d", "wired:layout:x"]] }))).toMatchInlineSnapshot(`
      [
        "persist.putEvent("event:#1")",
        "applyNativeRelaySetEvent("event:#1")",
        "applyNativeLayoutEvent("event:#1")",
        "dispatch events/addEvents ["event:#1"]",
        "dispatch relays/incrementCounts {"local":1}",
      ]
    `);
    h.native.relaySet = true;
    expect(await route(ev(30078, { tags: [["d", "wired:relays:x"]] }))).toMatchInlineSnapshot(`
      [
        "persist.putEvent("event:#2")",
        "applyNativeRelaySetEvent("event:#2")",
        "dispatch events/addEvents ["event:#2"]",
        "dispatch relays/incrementCounts {"local":1}",
      ]
    `);
  });

  it("kinds 39000 / 39001 / 39002: native sync first; 39002 falls back to a debounced member sync for a known space", async () => {
    store.dispatch(setSpaces([space()]));
    expect(
      await route(
        ev(39000, { tags: [["d", SPACE]] }),
        ev(39001, { tags: [["d", SPACE]] }),
        ev(39002, { tags: [["d", SPACE]] }),
        ev(39002, { tags: [["d", "unknown-space"]] }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "persist.putEvent("event:#1")",
        "applyNativeGroupEvent("event:#1")",
        "dispatch events/addEvents ["event:#1"]",
        "dispatch relays/incrementCounts {"local":1}",
        "persist.putEvent("event:#2")",
        "applyNativeGroupEvent("event:#2")",
        "dispatch events/addEvents ["event:#2"]",
        "dispatch relays/incrementCounts {"local":1}",
        "persist.putEvent("event:#3")",
        "applyNativeGroupEvent("event:#3")",
        "scheduleMemberSync("space1")",
        "dispatch events/addEvents ["event:#3"]",
        "dispatch relays/incrementCounts {"local":1}",
        "persist.putEvent("event:#4")",
        "applyNativeGroupEvent("event:#4")",
        "dispatch events/addEvents ["event:#4"]",
        "dispatch relays/incrementCounts {"local":1}",
      ]
    `);
    h.native.group = true;
    expect(await route(ev(39002, { tags: [["d", SPACE]] }))).toMatchInlineSnapshot(`
      [
        "persist.putEvent("event:#5")",
        "applyNativeGroupEvent("event:#5")",
        "dispatch events/addEvents ["event:#5"]",
        "dispatch relays/incrementCounts {"local":1}",
      ]
    `);
  });

  it("kind 20900 config nudge: schedules a config sync for a known space only", async () => {
    store.dispatch(setSpaces([space()]));
    expect(
      await route(
        ev(20900, { tags: [["d", SPACE], ["what", "channels"], ["what", "roles"]] }),
        ev(20900, { tags: [["d", "unknown-space"], ["what", "channels"]] }),
        ev(20900, { tags: [["d", SPACE], ["what", "not-a-change"]] }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "scheduleSpaceConfigSync("space1", ["channels","roles"])",
        "dispatch events/addEvents ["event:#1"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/addEvents ["event:#2"]",
        "dispatch relays/incrementCounts {"local":1}",
        "dispatch events/addEvents ["event:#3"]",
        "dispatch relays/incrementCounts {"local":1}",
      ]
    `);
  });

  it("kind 9005 moderator delete: an unknown space defers (unmarked, retried); an authorized one removes in-group targets", async () => {
    const msg = ev(9, { tags: [["h", SPACE], ["channel", "ch1"]] });
    const elsewhere = ev(9, { tags: [["h", "other-space"]] });
    const modDelete = ev(9005, { pubkey: OTHER, tags: [["h", SPACE], ["e", msg.id], ["e", elsewhere.id]] });
    const { pipeline } = harness();
    await pipeline.processIncomingEvent(msg, "local");
    await pipeline.processIncomingEvent(elsewhere, "local");
    take();
    // Space not loaded yet: dropped and unmarked.
    await pipeline.processIncomingEvent(modDelete, WS);
    pipeline.flushEventPipeline();
    const deferred = take();
    // Space known, author in its authority set: the redelivery is processed.
    store.dispatch(setSpaces([space({ adminPubkeys: [OTHER], spaceType: "nip29-native", relayPubkey: hex64(0xfee) } as Partial<Space>)]));
    take();
    await pipeline.processIncomingEvent(modDelete, WS);
    pipeline.flushEventPipeline();
    expect({ deferred, redelivered: take() }).toMatchInlineSnapshot(`
      {
        "deferred": [
          "verify("event:#3")",
          "dispatch events/addEvents ["event:#3"]",
          "dispatch relays/incrementCounts {"wss://relay.example":1}",
        ],
        "redelivered": [
          "verify("event:#3")",
          "dispatch events/addEvents ["event:#3"]",
          "dispatch relays/incrementCounts {"wss://relay.example":1}",
          "dispatch events/removeChatMessage {"contextId":"space1:ch1","eventId":"#1"}",
          "dispatch events/hideMessage "#1"",
          "dispatch events/removeEvent "#1"",
          "persist.deleteEvent("#1")",
          "persist.putEvent("event:#3")",
        ],
      }
    `);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("space feed indexing", () => {
  async function feedActions(...events: NostrEvent[]): Promise<string[]> {
    const { pipeline } = harness();
    take();
    for (const e of events) await pipeline.processIncomingEvent(e, "local");
    return take().filter((l) => l.startsWith("dispatch events/indexSpaceFeeds") || l.startsWith("dispatch events/removeEventFromAllSpaceFeeds"));
  }

  beforeEach(() => {
    store.dispatch(
      setSpaces([
        space(),
        space({ id: "space2", memberPubkeys: [AUTHOR, OTHER] }),
        space({ id: "feedspace", mode: "read", memberPubkeys: [AUTHOR], feedPubkeys: [OTHER] }),
      ]),
    );
    store.dispatch(
      setChannels({
        spaceId: SPACE,
        channels: [
          channel("notes1", "notes"), channel("media1", "media"), channel("music1", "music"),
          channel("music-curated", "music", { feedMode: "curated" }), channel("articles1", "articles"),
        ],
      }),
    );
    h.trace.length = 0;
  });

  it("a member's note lands in every space they are a member of; a feed-mode space takes feed sources only", async () => {
    expect(await feedActions(ev(1), ev(1, { pubkey: OTHER }), ev(1, { pubkey: hex64(0x5712) }))).toMatchInlineSnapshot(`
      [
        "dispatch events/indexSpaceFeeds [{"contextId":"space1:notes1","eventId":"#1"},{"contextId":"space1:notes","eventId":"#1"},{"contextId":"space2:notes","eventId":"#1"}]",
        "dispatch events/indexSpaceFeeds [{"contextId":"space2:notes","eventId":"#2"},{"contextId":"feedspace:notes","eventId":"#2"}]",
      ]
    `);
  });

  it("an h-tagged event indexes only into the spaces it names", async () => {
    expect(
      await feedActions(ev(31683, { tags: [["d", "t"], ["title", "T"], ["h", "space2"]] })),
    ).toMatchInlineSnapshot(`
      [
        "dispatch events/indexSpaceFeeds [{"contextId":"space2:music","eventId":"#1"}]",
      ]
    `);
  });

  it("channel tags target one channel; curated channels take only tagged events", async () => {
    expect(
      await feedActions(
        ev(31683, { tags: [["d", "a"], ["title", "A"]] }),
        ev(31683, { tags: [["d", "b"], ["title", "B"], ["channel", "music-curated"]] }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "dispatch events/indexSpaceFeeds [{"contextId":"space1:music1","eventId":"#1"},{"contextId":"space1:music","eventId":"#1"},{"contextId":"space2:music","eventId":"#1"}]",
        "dispatch events/indexSpaceFeeds [{"contextId":"space1:music-curated","eventId":"#2"},{"contextId":"space1:music","eventId":"#2"},{"contextId":"space2:music","eventId":"#2"}]",
      ]
    `);
  });

  it("a note with media also lands in the media feed", async () => {
    expect(await feedActions(ev(1, { content: "look https://example.com/a.jpg" }))).toMatchInlineSnapshot(`
      [
        "dispatch events/indexSpaceFeeds [{"contextId":"space1:notes1","eventId":"#1"},{"contextId":"space1:notes","eventId":"#1"},{"contextId":"space1:media1","eventId":"#1"},{"contextId":"space1:media","eventId":"#1"},{"contextId":"space2:notes","eventId":"#1"},{"contextId":"space2:media","eventId":"#1"}]",
      ]
    `);
  });

  it("private / unlisted music, off-catalog audio and chat-scoped polls stay out of space feeds", async () => {
    expect(
      await feedActions(
        ev(31683, { tags: [["d", "p"], ["title", "P"], ["visibility", "unlisted"]] }),
        ev(31683, { tags: [["d", "c"], ["title", "C"], ["catalog", "none"]] }),
        ev(1068, { tags: [["h", SPACE], ["option", "a", "A"]] }),
      ),
    ).toEqual([]);
  });

  it("a newer version of a track replaces the old event id in every space feed", async () => {
    expect(
      await feedActions(
        ev(31683, { tags: [["d", "t"], ["title", "v1"]], created_at: NOW - 100 }),
        ev(31683, { tags: [["d", "t"], ["title", "v2"]], created_at: NOW - 50 }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "dispatch events/indexSpaceFeeds [{"contextId":"space1:music1","eventId":"#1"},{"contextId":"space1:music","eventId":"#1"},{"contextId":"space2:music","eventId":"#1"}]",
        "dispatch events/indexSpaceFeeds [{"contextId":"space1:music1","eventId":"#2"},{"contextId":"space1:music","eventId":"#2"},{"contextId":"space2:music","eventId":"#2"}]",
      ]
    `);
  });

  it("the friends feed indexes follows (and self) only while it is the active space; reposts go to its notes channel", async () => {
    store.dispatch(setSpaces([]));
    store.dispatch(setFollowList({ follows: [AUTHOR], createdAt: 5 }));
    expect(await feedActions(ev(1))).toEqual([]);
    store.dispatch(setActiveSpace("__friends_feed__"));
    expect(
      await feedActions(
        ev(1),
        ev(1, { pubkey: ME, content: "pic https://example.com/a.png" }),
        ev(6, { tags: [["e", hex64(0x100)]] }),
        ev(1, { pubkey: OTHER }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "dispatch events/indexSpaceFeeds [{"contextId":"__friends_feed__:notes","eventId":"#2"}]",
        "dispatch events/indexSpaceFeeds [{"contextId":"__friends_feed__:notes","eventId":"#3"},{"contextId":"__friends_feed__:media","eventId":"#3"}]",
        "dispatch events/indexSpaceFeeds [{"contextId":"__friends_feed__:notes","eventId":"#4"}]",
      ]
    `);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("gift wraps", () => {
  const PARTNER = hex64(0xbeef);
  let wrapSeq = 0x9000;
  function wrap(over: Partial<NostrEvent> = {}): NostrEvent {
    wrapSeq += 1;
    return {
      id: hex64(wrapSeq), pubkey: hex64(0xe000 + wrapSeq), created_at: NOW - 3600, kind: 1059,
      tags: [["p", ME]], content: "ciphertext", sig: SIG, ...over,
    };
  }
  function rumor(w: NostrEvent, r: { kind: number; sender?: string; content?: string; tags?: string[][]; ageSec?: number }) {
    return {
      sender: r.sender ?? PARTNER, content: r.content ?? "", tags: r.tags ?? [["p", ME]],
      createdAt: NOW - (r.ageSec ?? 60), wrapId: w.id, rumorId: hex64(0xf000 + wrapSeq), kind: r.kind,
    };
  }
  /** Deliver a wrap whose decrypt yields `r`, through the registered handler. */
  async function open(hs: Harness, r: Parameters<typeof rumor>[1], over: Partial<NostrEvent> = {}): Promise<string[]> {
    const w = wrap(over);
    h.unwrap = async () => rumor(w, r);
    take();
    await hs.wrapHandler(w, NOW);
    return take();
  }

  beforeEach(() => {
    wrapSeq = 0x9000;
  });

  it("leaves the normal path after verification: counted, queued for decrypt, never stored", async () => {
    const hs = harness();
    take();
    const w = wrap();
    await hs.pipeline.processIncomingEvent(w, WS);
    vi.advanceTimersByTime(100);
    expect(take()).toMatchInlineSnapshot(`
      [
        "verify("event:#9001")",
        "dispatch relays/incrementEventCount "wss://relay.example"",
        "decryptQueue.submit("event:#9001")",
      ]
    `);
    expect(eventsSelectors.selectById(store.getState().events, w.id)).toBeUndefined();
  });

  it("a full decrypt queue unmarks the wrap, so a redelivery is queued again", async () => {
    const hs = harness();
    const w = wrap();
    hs.queueAccepts.value = false;
    await hs.pipeline.processIncomingEvent(w, WS);
    hs.queueAccepts.value = true;
    take();
    await hs.pipeline.processIncomingEvent(w, WS);
    expect(take().some((l) => l.startsWith("decryptQueue.submit"))).toBe(true);
  });

  it("is not decrypted while logged out (and stays retryable), nor when addressed to someone else", async () => {
    const hs = harness();
    const w = wrap();
    await hs.pipeline.processIncomingEvent(w, WS);
    dispatchSpy.mockRestore();
    store.dispatch(resetAll()); // logged out
    take();
    await hs.wrapHandler(w, NOW);
    const loggedOut = take();
    store.dispatch(login({ pubkey: ME, signerType: "tauri_keystore" }));
    take();
    await hs.pipeline.processIncomingEvent(w, WS); // was unmarked → processed again
    const retried = take().filter((l) => l.startsWith("decryptQueue.submit"));
    await hs.wrapHandler(wrap({ tags: [["p", OTHER]] }), NOW);
    expect({ loggedOut, retried, notOurs: take() }).toMatchInlineSnapshot(`
      {
        "loggedOut": [],
        "notOurs": [],
        "retried": [
          "decryptQueue.submit("event:#9001")",
        ],
      }
    `);
  });

  it("a transient decrypt failure unmarks; a wrap core rejected is recorded as processed and stays marked", async () => {
    const hs = harness();
    const transient = wrap();
    const rejected = wrap();
    await hs.pipeline.processIncomingEvent(transient, WS);
    await hs.pipeline.processIncomingEvent(rejected, WS);
    take();
    h.unwrap = async () => {
      throw new Error("signer timed out");
    };
    await hs.wrapHandler(transient, NOW);
    h.unwrap = async () => {
      throw new GiftWrapRejectedError("seal_sig", "Seal signature invalid");
    };
    await hs.wrapHandler(rejected, NOW);
    const handled = take();
    await hs.pipeline.processIncomingEvent(transient, WS);
    await hs.pipeline.processIncomingEvent(rejected, WS);
    expect({ handled, redelivered: take().filter((l) => l.startsWith("decryptQueue.submit")) }).toMatchInlineSnapshot(`
      {
        "handled": [
          "unwrapGiftWrap("event:#9001", {"now":1767225540})",
          "unwrapGiftWrap("event:#9002", {"now":1767225540})",
          "dispatch dm/markDMWrapProcessed "#9002"",
        ],
        "redelivered": [
          "decryptQueue.submit("event:#9001")",
        ],
      }
    `);
  });

  it("a text DM: stored with the rumor's time, delivered receipt queued, notification raised", async () => {
    expect(await open(harness(), { kind: 14, content: "hello" })).toMatchInlineSnapshot(`
      [
        "unwrapGiftWrap("event:#9001", {"now":1767225540})",
        "dispatch dm/addDMMessage {"partnerPubkey":"#beef","myPubkey":"#a11","message":{"id":"#9001","senderPubkey":"#beef","content":"hello","createdAt":1767225540,"wrapId":"#9001","rumorId":"#18001","kind":14,"wrapCreatedAt":1767222000}}",
        "queueDeliveredReceipt("#beef", "#18001")",
        "dispatch notifications/addNotification {"id":"dm-#beef-1767225600000","type":"dm","title":"New direct message","body":"hello","actorPubkey":"#beef","contextId":"#beef","timestamp":1767225600000}",
      ]
    `);
  });

  it("our own echo and a garbage sender raise nothing; a muted sender is dropped", async () => {
    const hs = harness();
    const own = await open(hs, { kind: 14, sender: ME, content: "mine", tags: [["p", PARTNER]] });
    const garbage = await open(hs, { kind: 14, sender: "not-a-pubkey", content: "x" });
    store.dispatch(setMuteList({ mutes: [{ type: "pubkey", value: PARTNER }], createdAt: 5 }));
    const muted = await open(hs, { kind: 14, content: "x" });
    expect({ own, garbage, muted }).toMatchInlineSnapshot(`
      {
        "garbage": [
          "unwrapGiftWrap("event:#9002", {"now":1767225540})",
        ],
        "muted": [
          "unwrapGiftWrap("event:#9003", {"now":1767225540})",
        ],
        "own": [
          "unwrapGiftWrap("event:#9001", {"now":1767225540})",
          "dispatch dm/addDMMessage {"partnerPubkey":"#beef","myPubkey":"#a11","message":{"id":"#9001","senderPubkey":"#a11","content":"mine","createdAt":1767225540,"wrapId":"#9001","rumorId":"#18001","kind":14,"wrapCreatedAt":1767222000}}",
        ],
      }
    `);
  });

  it("friend request, accept and removal rumors route to the friend-request slice", async () => {
    const hs = harness();
    const request = await open(hs, { kind: 14, content: "be my friend", tags: [["p", ME], ["type", "friend_request"]] });
    const accept = await open(hs, { kind: 14, tags: [["p", ME], ["type", "friend_request_accept"]] });
    const remove = await open(hs, { kind: 14, tags: [["p", ME], ["type", "friend_request_remove"]] });
    expect({ request, accept, remove }).toMatchInlineSnapshot(`
      {
        "accept": [
          "unwrapGiftWrap("event:#9002", {"now":1767225540})",
          "dispatch friendRequests/addProcessedWrapId "#9002"",
          "dispatch friendRequests/applyAcceptWrap {"pubkey":"#beef","direction":"outgoing","wrapId":"#9002","createdAt":1767225540}",
          "dispatch identity/addKnownFollower "#beef"",
          "followUser("#beef")",
          "dispatch notifications/addNotification {"id":"friend-accept-#beef-1767225600000","type":"friend_request","title":"Friend request accepted","body":"00000000... accepted your friend request","actorPubkey":"#beef","timestamp":1767225600000}",
        ],
        "remove": [
          "unwrapGiftWrap("event:#9003", {"now":1767225540})",
          "dispatch friendRequests/addProcessedWrapId "#9003"",
          "dispatch friendRequests/applyRemoveWrap {"pubkey":"#beef","createdAt":1767225540}",
        ],
        "request": [
          "unwrapGiftWrap("event:#9001", {"now":1767225540})",
          "dispatch friendRequests/addFriendRequest {"id":"#9001","pubkey":"#beef","message":"be my friend","createdAt":1767225540,"status":"pending","direction":"incoming"}",
          "dispatch notifications/addNotification {"id":"friend-req-#beef","type":"friend_request","title":"Friend request","body":"be my friend","actorPubkey":"#beef","timestamp":1767225600000,"actionType":"accept_friend","actionTarget":"#beef"}",
        ],
      }
    `);
  });

  it("call signalling: a stale invite is only recorded, a fresh one rings, a missed-call rumor ends the ring, a decline with no outgoing call is only recorded", async () => {
    const hs = harness();
    const staleInvite = await open(hs, {
      kind: 14, ageSec: 3600, tags: [["p", ME], ["type", "call_invite"]],
      content: JSON.stringify({ roomSecretKey: "k", callType: "audio", caps: { e2ee: true } }),
    });
    const freshInvite = await open(hs, {
      kind: 14, ageSec: 5, tags: [["p", ME], ["type", "call_invite"]],
      content: JSON.stringify({ roomSecretKey: "k", callType: "audio", callerName: "P", caps: { e2ee: true } }),
    });
    const missed = await open(hs, { kind: 14, ageSec: 5, tags: [["p", ME], ["type", "call_missed"]] });
    const decline = await open(hs, { kind: 14, ageSec: 5, tags: [["p", ME], ["type", "call_decline"]] });
    expect({ staleInvite, freshInvite, missed, decline }).toMatchInlineSnapshot(`
      {
        "decline": [
          "unwrapGiftWrap("event:#9004", {"now":1767225540})",
          "dispatch call/addProcessedCallWrapId "#9004"",
        ],
        "freshInvite": [
          "unwrapGiftWrap("event:#9002", {"now":1767225540})",
          "dispatch call/addProcessedCallWrapId "#9002"",
          "dispatch call/setIncomingCall {"callerPubkey":"#beef","roomSecretKey":"k","callType":"audio","callerName":"P","timestamp":1767225600000,"caps":{"e2ee":true}}",
        ],
        "missed": [
          "unwrapGiftWrap("event:#9003", {"now":1767225540})",
          "dispatch call/addProcessedCallWrapId "#9003"",
          "dispatch call/missedCall",
        ],
        "staleInvite": [
          "unwrapGiftWrap("event:#9001", {"now":1767225540})",
          "dispatch call/addProcessedCallWrapId "#9001"",
        ],
      }
    `);
  });
});
