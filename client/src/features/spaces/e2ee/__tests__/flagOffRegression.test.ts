import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { getConversationKey, decrypt as nip44v2Decrypt } from "nostr-tools/nip44";
import type { NostrEvent, UnsignedEvent } from "@/types/nostr";
import type { Space } from "@/types/space";

// Regression: with the Encrypted spaces feature OFF nothing about ordinary
// spaces or NIP-17 DMs changes, and with it ON a space that is not encrypted
// behaves exactly as before (docs/E2EE_SPACES.md §12).

const h = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  me: { sk: null as Uint8Array | null },
  unwrap: vi.fn(),
}));

vi.mock("@/lib/nostr/secretStore", () => ({
  isSecretPersistEnabled: () => true,
  getSecret: async (k: string) => h.keychain.get(k) ?? null,
  setSecret: async (k: string, v: string) => void h.keychain.set(k, v),
  deleteSecret: async (k: string) => void h.keychain.delete(k),
}));
vi.mock("@/lib/nostr/loginFlow", () => ({
  getSigner: () => ({
    getPublicKey: async () => getPublicKey(h.me.sk!),
    signEvent: async (unsigned: UnsignedEvent) => finalizeEvent(unsigned as never, h.me.sk!),
  }),
  getSignerTimeoutMs: () => 5_000,
}));
vi.mock("@/lib/nostr/nip44", () => ({
  nip44Encrypt: async () => "",
  nip44Decrypt: async (peer: string, ct: string) => nip44v2Decrypt(ct, getConversationKey(h.me.sk!, peer)),
}));
vi.mock("@/lib/nostr/giftWrap", () => ({
  unwrapGiftWrap: (...a: unknown[]) => h.unwrap(...a),
}));
vi.mock("@/lib/nostr/publishOutbox", () => ({ publishOutbox: { record: vi.fn() } }));

import { buildSpaceKeyGrants, buildSpaceRumor, epochIdOf, generateEpochKey, sealSpaceEvent } from "@ishtarservices/core";
import { store, resetAll } from "@/store";
import { login } from "@/store/slices/identitySlice";
import { addSpace, setActiveSpace } from "@/store/slices/spacesSlice";
import { setFeatureEnabled, FEATURE_E2EE_SPACES } from "@/store/slices/featuresSlice";
import { clearAllUserState, setActivePubkey } from "@/lib/db/userStateStore";
import { processIncomingEvent, resetEventPipelineCaches, flushEventPipeline } from "@/lib/nostr/eventPipeline";
import { signAndPublish, signWithAccount } from "@/lib/nostr/publish";
import { encryptedSpaceEntry, selectHasSpaceKey, selectIsEncryptedSpace } from "@/store/slices/spaceE2eeSlice";
import { relayManager } from "@/lib/nostr/relayManager";
import { subscriptionManager } from "@/lib/nostr/subscriptionManager";
import { buildChatMessage } from "@/lib/nostr/eventBuilder";
import { startSpaceE2ee, stopSpaceE2ee } from "../e2eeController";
import { isEncryptedSpace, sendEpochOf } from "../spaceKeyring";

const HOST = "wss://space.example";
const SPACE = "plainspace01";
const CHANNEL = "general";

const meSk = generateSecretKey();
const me = getPublicKey(meSk);
const aliceSk = generateSecretKey();
const alice = getPublicKey(aliceSk);

function space(over: Partial<Space> = {}): Space {
  return {
    id: SPACE,
    hostRelay: HOST,
    name: "Plain",
    isPrivate: false,
    adminPubkeys: [alice],
    memberPubkeys: [alice, me],
    feedPubkeys: [],
    mode: "read-write",
    creatorPubkey: alice,
    createdAt: 1,
    ...over,
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((res) => setTimeout(res, 5));
};

function chat(): NostrEvent[] {
  flushEventPipeline();
  const state = store.getState();
  return (state.events.chatMessages[`${SPACE}:${CHANNEL}`] ?? []).map((id) => state.events.entities[id]!);
}

const key = generateEpochKey();
function grant(): NostrEvent {
  const [unsigned] = buildSpaceKeyGrants({
    granter: alice,
    spaceId: SPACE,
    epochKey: key,
    seq: 0,
    prev: null,
    root: alice,
    managers: [alice],
    history: "epoch",
    at: 1_763_000_000,
    recipients: [alice, me],
  });
  return finalizeEvent(unsigned as never, aliceSk) as unknown as NostrEvent;
}
function sealed(content: string): NostrEvent {
  const rumor = buildSpaceRumor(alice, SPACE, 9, [["channel", CHANNEL]], content);
  return finalizeEvent(sealSpaceEvent(rumor, SPACE, key) as never, aliceSk) as unknown as NostrEvent;
}
function plain(content: string): NostrEvent {
  return finalizeEvent(buildChatMessage(alice, SPACE, content, undefined, CHANNEL) as never, aliceSk) as unknown as NostrEvent;
}

let published: NostrEvent[] = [];
let subscribe: ReturnType<typeof vi.spyOn>;

function setFeature(enabled: boolean): void {
  store.dispatch(setFeatureEnabled({ feature: FEATURE_E2EE_SPACES, enabled }));
}

beforeEach(async () => {
  await clearAllUserState();
  h.me.sk = meSk;
  h.keychain.clear();
  h.unwrap.mockReset();
  published = [];
  vi.spyOn(relayManager, "connect").mockImplementation(() => undefined as never);
  // The paged grant fetch talks to the relay layer directly; nothing answers here.
  vi.spyOn(relayManager, "subscribe").mockImplementation(() => "paged-sub");
  vi.spyOn(relayManager, "closeSubscription").mockImplementation(() => undefined as never);
  vi.spyOn(relayManager, "publish").mockImplementation((event: unknown) => {
    published.push(event as NostrEvent);
    return 1;
  });
  let n = 0;
  subscribe = vi.spyOn(subscriptionManager, "subscribe").mockImplementation(() => `sub-${++n}`);
  vi.spyOn(subscriptionManager, "close").mockImplementation(() => undefined as never);
  store.dispatch(resetAll());
  resetEventPipelineCaches();
  setActivePubkey(me);
  store.dispatch(login({ pubkey: me, signerType: "nip07" }));
  store.dispatch(addSpace(space()));
  startSpaceE2ee();
  await settle();
});

afterEach(async () => {
  await settle();
  stopSpaceE2ee();
  store.dispatch(resetAll());
  setActivePubkey(null);
  vi.restoreAllMocks();
});

describe("feature off", () => {
  it("opens no subscription of its own", async () => {
    store.dispatch(setActiveSpace(SPACE));
    await settle();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("ignores key grants and sealed events: nothing marked, stored, indexed or decrypted", async () => {
    await processIncomingEvent(grant(), HOST);
    await processIncomingEvent(sealed("hidden"), HOST);
    await settle();
    expect(store.getState().spaceE2ee.spaces[SPACE]).toBeUndefined();
    expect(h.keychain.size).toBe(0);
    expect(chat()).toHaveLength(0);
    expect(store.getState().events.ids).toHaveLength(0);
  });

  it("leaves those events deliverable, so turning the feature on later picks them up", async () => {
    const g = grant();
    const s = sealed("readable once the feature is on");
    await processIncomingEvent(g, HOST);
    await processIncomingEvent(s, HOST);
    setFeature(true);
    await settle();
    await processIncomingEvent(s, HOST);
    await processIncomingEvent(g, HOST);
    await settle();
    expect(sendEpochOf(SPACE)?.info.id).toBe(epochIdOf(key));
    expect(chat().map((e) => e.content)).toEqual(["readable once the feature is on"]);
  });
});

describe.each([
  ["off", false],
  ["on", true],
])("an unencrypted space with the feature %s", (_label, enabled) => {
  beforeEach(async () => {
    setFeature(enabled);
    await settle();
  });

  it("receives plaintext chat as before", async () => {
    const event = plain("ordinary message");
    await processIncomingEvent(event, HOST);
    expect(chat()).toEqual([event]);
  });

  it("sends plaintext kind 9 with the same shape as before", async () => {
    const unsigned = buildChatMessage(me, SPACE, "hello", { eventId: "e".repeat(64), pubkey: alice }, CHANNEL);
    const signed = await signAndPublish(unsigned, [HOST]);
    expect(published).toEqual([signed]);
    expect(signed.kind).toBe(9);
    expect(signed.content).toBe("hello");
    expect(signed.tags).toEqual([
      ["h", SPACE],
      ["channel", CHANNEL],
      ["q", "e".repeat(64)],
      ["p", alice],
    ]);
    expect(chat().map((e) => e.id)).toEqual([signed.id]);
  });

  it("still signs other space content (reactions, notes) for it", async () => {
    const reaction: UnsignedEvent = { pubkey: me, created_at: 1, kind: 7, tags: [["h", SPACE], ["e", "a".repeat(64)]], content: "+" };
    await expect(signAndPublish(reaction, [HOST])).resolves.toMatchObject({ kind: 7 });
  });

  it("routes a gift wrap to the DM unwrap exactly once", async () => {
    h.unwrap.mockRejectedValue(new Error("not for this test"));
    const wrap: NostrEvent = {
      id: "f".repeat(64),
      pubkey: "c".repeat(64),
      created_at: Math.floor(Date.now() / 1000) - 3600,
      kind: 1059,
      tags: [["p", me]],
      content: "ciphertext",
      sig: "0".repeat(128),
    };
    await processIncomingEvent(wrap, HOST);
    await settle();
    expect(h.unwrap).toHaveBeenCalledTimes(1);
    expect(h.unwrap.mock.calls[0][0]).toBe(wrap);
  });

  it("never marks the space encrypted", () => {
    expect(store.getState().spaceE2ee.spaces).toEqual({});
  });

  // Space ids are other people's strings. One that names an Object.prototype
  // member must not look like an encrypted space to the guards.
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "does not take a space whose id is %j for an encrypted one",
    (id) => {
      const state = store.getState();
      expect(encryptedSpaceEntry(state.spaceE2ee.spaces, id)).toBeUndefined();
      expect(selectIsEncryptedSpace(id)(state)).toBe(false);
      expect(selectHasSpaceKey(id)(state)).toBe(false);
      expect(isEncryptedSpace(id)).toBe(false);
    },
  );

  it("still signs plaintext chat for a space with such an id", async () => {
    const unsigned = buildChatMessage(me, "constructor", "hi", undefined, CHANNEL);
    // Signing is where the guard sits; the local pipeline pass is not under test.
    await expect(signWithAccount(unsigned)).resolves.toMatchObject({ kind: 9, content: "hi" });
  });
});

describe("feature on: subscriptions", () => {
  beforeEach(async () => {
    setFeature(true);
    await settle();
  });

  function filters(): Array<Record<string, unknown>> {
    return subscribe.mock.calls.flatMap(
      (c: unknown[]) => (c[0] as { filters: Array<Record<string, unknown>> }).filters,
    );
  }

  it("asks only for key grants of the joined spaces, on the space's own relay", () => {
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0][0]).toMatchObject({ filters: [{ kinds: [4291], "#h": [SPACE] }], relayUrls: [HOST] });
  });

  // A REQ that beats NIP-42 AUTH to the relay is answered empty and never
  // re-run; the controller asks again while a stored query stays empty.
  it("re-asks a stored query that came back empty, with backoff, a bounded number of times", async () => {
    vi.useFakeTimers();
    try {
      const eose = (call: number) => (subscribe.mock.calls[call][0] as { onEOSE: () => void }).onEOSE();
      for (let attempt = 0; attempt < 5; attempt++) {
        eose(attempt);
        await vi.advanceTimersByTimeAsync(1_500 * 2 ** attempt - 1);
        expect(subscribe).toHaveBeenCalledTimes(attempt + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(subscribe).toHaveBeenCalledTimes(attempt + 2);
        expect(vi.mocked(subscriptionManager.close)).toHaveBeenCalledWith(`sub-${attempt + 1}`);
      }
      // The sixth empty answer is accepted.
      eose(5);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(subscribe).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops re-asking once a grant for the space has arrived", async () => {
    await processIncomingEvent(grant(), HOST);
    await settle();
    const before = subscribe.mock.calls.length;
    vi.useFakeTimers();
    try {
      (subscribe.mock.calls[0][0] as { onEOSE: () => void }).onEOSE();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(subscribe.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-ask the live-only background subscription", async () => {
    await processIncomingEvent(grant(), HOST);
    await settle();
    const bg = subscribe.mock.calls.find(
      (c: unknown[]) => typeof (c[0] as { filters: Array<{ since?: number }> }).filters[0].since === "number",
    )!;
    expect((bg[0] as { onEOSE?: unknown }).onEOSE).toBeUndefined();
  });

  it("adds sealed-event subscriptions once a space is known to be encrypted, and never asks for plaintext kinds", async () => {
    store.dispatch(setActiveSpace(SPACE));
    await processIncomingEvent(grant(), HOST);
    await settle();
    const all = filters();
    const kinds = new Set(all.flatMap((f) => f.kinds as number[]));
    expect([...kinds].sort()).toEqual([4290, 4291]);
    // One recent-only background filter and one history filter for the open space.
    const sealedFilters = all.filter((f) => (f.kinds as number[])[0] === 4290);
    expect(sealedFilters.some((f) => typeof f.since === "number")).toBe(true);
    expect(sealedFilters.some((f) => f.limit === 500 && f.since === undefined)).toBe(true);
  });

  it("fetches this account's grants by recipient, to the end, on the space's relay", async () => {
    const paged = vi.mocked(relayManager.subscribe).mock.calls.map(
      (c) => c[0] as unknown as { filters: Array<Record<string, unknown>>; relayUrls: string[] },
    );
    const mine = paged.find((o) => (o.filters[0]["#p"] as string[] | undefined)?.includes(me));
    expect(mine).toBeDefined();
    expect(mine!.relayUrls).toEqual([HOST]);
    expect(mine!.filters[0]).toMatchObject({ kinds: [4291], "#h": [SPACE], "#p": [me], limit: 500 });
  });

  it("closes everything when the feature is switched off again", async () => {
    const close = vi.mocked(subscriptionManager.close);
    setFeature(false);
    await settle();
    expect(close).toHaveBeenCalledWith("sub-1");
  });
});
