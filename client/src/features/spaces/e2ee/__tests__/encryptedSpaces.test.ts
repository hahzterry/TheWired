import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { getConversationKey, decrypt as nip44v2Decrypt } from "nostr-tools/nip44";
import { bytesToHex } from "@noble/hashes/utils";
import type { NostrEvent, UnsignedEvent } from "@/types/nostr";
import type { Space } from "@/types/space";

// Encrypted spaces through the REAL store, pipeline, keyring, key store and
// publish path (docs/E2EE_SPACES.md). Stubbed: the keychain (a Map), the
// account signer (a local key), the relay socket layer (captures publishes).
// Signature verification is globally mocked to pass (vitest.setup.ts), so
// events from "other members" are built with real keys but need no relay.

const h = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  published: [] as Array<{ event: unknown; targets: string[] | undefined }>,
  me: { sk: null as Uint8Array | null },
  signerAway: false,
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
  nip44Encrypt: async () => {
    throw new Error("the account key must not be used to encrypt here");
  },
  nip44Decrypt: async (peer: string, ciphertext: string) => {
    if (h.signerAway) throw new Error("signer timed out");
    return nip44v2Decrypt(ciphertext, getConversationKey(h.me.sk!, peer));
  },
}));
vi.mock("@/lib/nostr/publishOutbox", () => ({ publishOutbox: { record: vi.fn() } }));

import {
  buildSpaceKeyGrants,
  buildSpaceRumor,
  epochIdOf,
  generateEpochKey,
  openSealedSpaceEvent,
  openSpaceKeyGrant,
  readGrantHeader,
  sealSpaceEvent,
  SpaceE2eeError,
} from "@ishtarservices/core";
import { store, resetAll } from "@/store";
import { login } from "@/store/slices/identitySlice";
import { addSpace, updateSpaceMembers } from "@/store/slices/spacesSlice";
import { setFeatureEnabled, FEATURE_E2EE_SPACES } from "@/store/slices/featuresSlice";
import { clearAllUserState, setActivePubkey } from "@/lib/db/userStateStore";
import { processIncomingEvent, resetEventPipelineCaches, flushEventPipeline } from "@/lib/nostr/eventPipeline";
import { registerSpaceE2eeHooks } from "@/lib/nostr/spaceE2eeHooks";
import { signAndPublish } from "@/lib/nostr/publish";
import { relayManager } from "@/lib/nostr/relayManager";
import { buildChatMessage, buildChatEditEvent, buildDeletionEvent } from "@/lib/nostr/eventBuilder";
import {
  clearSpaceE2eeSession,
  ensureSpaceE2eeHydrated,
  getEpochKey,
  handleKeyGrant,
  isSpaceKeyManager,
  onSpaceEpochReady,
  prepareFirstEpoch,
  publishFirstEpoch,
  retryPendingGrants,
  sendEpochOf,
  type GrantOutcome,
} from "../spaceKeyring";
import { _resetKeyReconcile, reconcileSpaceKeys } from "../keyReconcile";
import { clearSealedChatSession, openSealedFromPipeline, releaseParked, sealForSpace } from "../sealedChat";
import { spaceKeySlot } from "../spaceKeyStore";

const HOST = "wss://space.example";
const SPACE = "encspace01";
const CHANNEL = "general";

interface Person {
  sk: Uint8Array;
  pubkey: string;
  decrypt: (peer: string, ciphertext: string) => Promise<string>;
}
function person(): Person {
  const sk = generateSecretKey();
  return {
    sk,
    pubkey: getPublicKey(sk),
    decrypt: async (peer, ct) => nip44v2Decrypt(ct, getConversationKey(sk, peer)),
  };
}

const me = person();
const alice = person(); // another space admin / creator, depending on the test
const bob = person();
const carol = person();
const dave = person();

function space(over: Partial<Space> = {}): Space {
  return {
    id: SPACE,
    hostRelay: HOST,
    name: "Encrypted",
    isPrivate: false,
    adminPubkeys: [me.pubkey],
    memberPubkeys: [me.pubkey],
    feedPubkeys: [],
    mode: "read-write",
    creatorPubkey: me.pubkey,
    createdAt: 1,
    spaceType: "nip29-native",
    ...over,
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((res) => setTimeout(res, 5));
};

function setRoster(members: string[]): void {
  store.dispatch(updateSpaceMembers({ spaceId: SPACE, members }));
}

function publishedOfKind(kind: number): NostrEvent[] {
  return h.published.map((p) => p.event as NostrEvent).filter((e) => e.kind === kind);
}

function chatIn(channel = CHANNEL): NostrEvent[] {
  flushEventPipeline();
  const state = store.getState();
  return (state.events.chatMessages[`${SPACE}:${channel}`] ?? []).map((id) => state.events.entities[id]!);
}

/** A sealed chat message from another member, signed with their key. */
function sealedFrom(who: Person, key: Uint8Array, content: string, tags: string[][] = [["channel", CHANNEL]]): NostrEvent {
  const rumor = buildSpaceRumor(who.pubkey, SPACE, 9, tags, content);
  return finalizeEvent(sealSpaceEvent(rumor, SPACE, key) as never, who.sk) as unknown as NostrEvent;
}

/** A grant from another manager, signed with their key. */
function grantFrom(
  who: Person,
  key: Uint8Array,
  recipients: string[],
  over: Partial<Parameters<typeof buildSpaceKeyGrants>[0]> = {},
): NostrEvent {
  const [unsigned] = buildSpaceKeyGrants({
    granter: who.pubkey,
    spaceId: SPACE,
    epochKey: key,
    seq: 0,
    prev: null,
    managers: [who.pubkey],
    history: "epoch",
    at: 1_763_000_000,
    recipients,
    ...over,
  });
  return finalizeEvent(unsigned as never, who.sk) as unknown as NostrEvent;
}

function deliverGrant(event: NostrEvent): Promise<GrantOutcome> {
  return new Promise((resolve) => {
    const judged = handleKeyGrant(event, resolve);
    if (!judged) resolve("invalid");
  });
}

async function sendChat(content: string): Promise<NostrEvent> {
  const unsigned = buildChatMessage(me.pubkey, SPACE, content, undefined, CHANNEL);
  return signAndPublish(await sealForSpace(unsigned, SPACE), [HOST]);
}

function startHooks(): void {
  registerSpaceE2eeHooks({ onKeyGrant: (e) => handleKeyGrant(e), openSealed: openSealedFromPipeline });
}

let stopEpochListener: (() => void) | null = null;

beforeEach(async () => {
  // The non-secret record persists in (fake) IndexedDB; start each test clean.
  await clearAllUserState();
  vi.spyOn(relayManager, "connect").mockImplementation(() => undefined as never);
  vi.spyOn(relayManager, "publish").mockImplementation((event: unknown, targets?: string[]) => {
    h.published.push({ event, targets });
    return 1;
  });
  h.me.sk = me.sk;
  h.signerAway = false;
  h.keychain.clear();
  h.published.length = 0;
  store.dispatch(resetAll());
  resetEventPipelineCaches();
  clearSpaceE2eeSession();
  clearSealedChatSession();
  // The authority's roster, for these tests, is whatever the store holds now.
  _resetKeyReconcile(async (sp) => store.getState().spaces.list.find((x) => x.id === sp.id)?.memberPubkeys ?? null);
  setActivePubkey(me.pubkey);
  store.dispatch(login({ pubkey: me.pubkey, signerType: "nip07" }));
  store.dispatch(setFeatureEnabled({ feature: FEATURE_E2EE_SPACES, enabled: true }));
  startHooks();
  stopEpochListener = onSpaceEpochReady((spaceId, epochId) => void releaseParked(spaceId, epochId));
});

afterEach(async () => {
  await settle();
  stopEpochListener?.();
  registerSpaceE2eeHooks(null);
  clearSpaceE2eeSession();
  clearSealedChatSession();
  store.dispatch(resetAll());
  setActivePubkey(null);
  vi.restoreAllMocks();
});

describe("creating an encrypted space", () => {
  it("stores the first key in the keychain and never in Redux", async () => {
    const s = space();
    await prepareFirstEpoch(s, "epoch");
    const current = sendEpochOf(SPACE)!;
    expect(current.info.seq).toBe(0);
    expect(current.info.managers).toEqual([me.pubkey]);

    const slot = JSON.parse(h.keychain.get(spaceKeySlot(me.pubkey, SPACE))!);
    expect(slot.keys[current.info.id]).toBe(bytesToHex(current.key));
    expect(JSON.stringify(store.getState())).not.toContain(bytesToHex(current.key));
    expect(store.getState().spaceE2ee.spaces[SPACE].root).toBe(me.pubkey);
    expect(isSpaceKeyManager(SPACE)).toBe(true);
  });

  it("is idempotent across a retried creation", async () => {
    await prepareFirstEpoch(space(), "epoch");
    const first = sendEpochOf(SPACE)!.info.id;
    await prepareFirstEpoch(space(), "epoch");
    expect(sendEpochOf(SPACE)!.info.id).toBe(first);
    expect(store.getState().spaceE2ee.spaces[SPACE].epochs).toHaveLength(1);
  });

  it("publishes one grant to the space's relay with the creator as recipient", async () => {
    const s = space();
    await prepareFirstEpoch(s, "epoch");
    store.dispatch(addSpace(s));
    await publishFirstEpoch(s);
    await settle();

    const grants = publishedOfKind(4291);
    expect(grants).toHaveLength(1);
    expect(h.published[0].targets).toEqual([HOST]);
    expect(readGrantHeader(grants[0])!.recipients).toEqual([me.pubkey]);
    expect(JSON.stringify(grants[0])).not.toContain(bytesToHex(sendEpochOf(SPACE)!.key));
    // Any device of the creator re-derives the key from that event alone.
    const opened = await openSpaceKeyGrant(grants[0], me.pubkey, me.decrypt);
    expect(bytesToHex(opened.key)).toBe(bytesToHex(sendEpochOf(SPACE)!.key));
  });

  it("fails the creation when the keychain write fails, leaving no key", async () => {
    const secretStore = await import("@/lib/nostr/secretStore");
    const spy = vi.spyOn(secretStore, "setSecret").mockRejectedValueOnce(new Error("keychain locked"));
    await expect(prepareFirstEpoch(space(), "epoch")).rejects.toThrow("keychain locked");
    expect(sendEpochOf(SPACE)).toBeNull();
    expect(store.getState().spaceE2ee.spaces[SPACE]).toBeUndefined();
    spy.mockRestore();
  });
});

describe("sending and receiving", () => {
  beforeEach(async () => {
    const s = space({ memberPubkeys: [me.pubkey, bob.pubkey] });
    await prepareFirstEpoch(s, "epoch");
    store.dispatch(addSpace(s));
    h.published.length = 0;
  });

  it("publishes ciphertext only, and renders the message in its channel", async () => {
    await sendChat("the plan is in the usual place");
    const [sent] = publishedOfKind(4290);
    expect(publishedOfKind(9)).toHaveLength(0);
    expect(sent.tags).toEqual([
      ["h", SPACE],
      ["epoch", sendEpochOf(SPACE)!.info.id],
    ]);
    expect(JSON.stringify(sent)).not.toContain("usual place");
    expect(JSON.stringify(sent)).not.toContain(CHANNEL);

    const [shown] = chatIn();
    expect(shown.id).toBe(sent.id);
    expect(shown.kind).toBe(9);
    expect(shown.content).toBe("the plan is in the usual place");
  });

  it("renders another member's sealed message and lets them read ours", async () => {
    const key = sendEpochOf(SPACE)!.key;
    await processIncomingEvent(sealedFrom(bob, key, "hi from bob"), HOST);
    expect(chatIn().map((e) => e.content)).toEqual(["hi from bob"]);

    const sent = await sendChat("hi bob");
    expect(openSealedSpaceEvent(sent, key).content).toBe("hi bob");
  });

  it("keeps replies and mentions inside the ciphertext", async () => {
    const unsigned = buildChatMessage(me.pubkey, SPACE, "agreed", { eventId: "e".repeat(64), pubkey: bob.pubkey }, CHANNEL);
    const sent = await signAndPublish(await sealForSpace(unsigned, SPACE), [HOST]);
    expect(sent.tags.some((t) => t[0] === "p" || t[0] === "q")).toBe(false);
    const [shown] = chatIn();
    expect(shown.tags).toContainEqual(["q", "e".repeat(64)]);
    expect(shown.tags).toContainEqual(["p", bob.pubkey]);
  });

  it("applies a sealed edit and a plaintext deletion to a sealed message", async () => {
    const sent = await sendChat("frist");
    const edit = buildChatEditEvent(me.pubkey, SPACE, sent.id, "first", CHANNEL);
    await signAndPublish(await sealForSpace(edit, SPACE), [HOST]);
    flushEventPipeline();
    const editId = store.getState().events.editedMessages[sent.id];
    expect(store.getState().events.entities[editId]!.content).toBe("first");
    expect(chatIn()).toHaveLength(1);

    const deletion = buildDeletionEvent(me.pubkey, { eventIds: [sent.id] }, undefined, ["9"]);
    deletion.tags.push(["h", SPACE]);
    await signAndPublish(deletion, [HOST]);
    flushEventPipeline();
    // The deletion references the OUTER id, so the relay can drop the row too.
    expect(publishedOfKind(5)[0].tags).toContainEqual(["e", sent.id]);
    expect(chatIn()).toHaveLength(0);
    expect(store.getState().events.entities[sent.id]).toBeUndefined();
  });

  it("drops a tampered sealed event and one member re-posting another's ciphertext", async () => {
    const key = sendEpochOf(SPACE)!.key;
    const real = sealedFrom(bob, key, "authentic");
    // Flip one bit in the middle of the base64 payload.
    const i = Math.floor(real.content.length / 2);
    const flipped = real.content.slice(0, i) + (real.content[i] === "A" ? "B" : "A") + real.content.slice(i + 1);
    await processIncomingEvent({ ...real, id: "1".repeat(64), content: flipped }, HOST);
    const stolen = finalizeEvent(
      { kind: real.kind, created_at: real.created_at, tags: real.tags, content: real.content } as never,
      carol.sk,
    ) as unknown as NostrEvent;
    await processIncomingEvent(stolen, HOST);
    expect(chatIn()).toHaveLength(0);
  });

  it("drops a replayed rumor under a new outer event", async () => {
    const key = sendEpochOf(SPACE)!.key;
    const rumor = buildSpaceRumor(bob.pubkey, SPACE, 9, [["channel", CHANNEL]], "once");
    const first = finalizeEvent(sealSpaceEvent(rumor, SPACE, key) as never, bob.sk) as unknown as NostrEvent;
    const again = finalizeEvent(
      { ...sealSpaceEvent(rumor, SPACE, key), created_at: rumor.created_at + 30 } as never,
      bob.sk,
    ) as unknown as NostrEvent;
    expect(again.id).not.toBe(first.id);
    await processIncomingEvent(first, HOST);
    await processIncomingEvent(again, HOST);
    expect(chatIn().map((e) => e.content)).toEqual(["once"]);
  });

  it("ignores plaintext chat in an encrypted space", async () => {
    const plain = finalizeEvent(buildChatMessage(bob.pubkey, SPACE, "not sealed", undefined, CHANNEL) as never, bob.sk);
    await processIncomingEvent(plain as unknown as NostrEvent, HOST);
    expect(chatIn()).toHaveLength(0);
  });

  it("refuses to sign plaintext content for an encrypted space, and still signs what stays in the clear", async () => {
    await expect(signAndPublish(buildChatMessage(me.pubkey, SPACE, "leak", undefined, CHANNEL), [HOST])).rejects.toThrow(
      /end-to-end encrypted/,
    );
    await expect(
      signAndPublish({ pubkey: me.pubkey, created_at: 1, kind: 7, tags: [["h", SPACE], ["e", "a".repeat(64)]], content: "+" }, [HOST]),
    ).rejects.toThrow(/end-to-end encrypted/);
    expect(h.published).toHaveLength(0);

    const deletion = buildDeletionEvent(me.pubkey, { eventIds: ["a".repeat(64)] });
    deletion.tags.push(["h", SPACE]);
    await expect(signAndPublish(deletion, [HOST])).resolves.toBeTruthy();
  });

  it("cannot seal without a key", async () => {
    clearSpaceE2eeSession();
    h.keychain.clear();
    await ensureSpaceE2eeHydrated();
    await expect(sealForSpace(buildChatMessage(me.pubkey, SPACE, "x", undefined, CHANNEL), SPACE)).rejects.toThrow(
      /Waiting for an admin/,
    );
  });
});

describe("handing out keys and rotating (manager)", () => {
  beforeEach(async () => {
    const s = space({ memberPubkeys: [me.pubkey] });
    await prepareFirstEpoch(s, "epoch");
    store.dispatch(addSpace(s));
    await publishFirstEpoch(s);
    await settle();
    h.published.length = 0;
  });

  async function keyOf(who: Person, grant: NostrEvent): Promise<Uint8Array> {
    return (await openSpaceKeyGrant(grant, who.pubkey, who.decrypt)).key;
  }

  it("hands the current key to a member who joins, with one signature", async () => {
    const before = await sendChat("before bob joined");
    setRoster([me.pubkey, bob.pubkey]);
    await reconcileSpaceKeys(SPACE);
    await settle();

    const grants = publishedOfKind(4291);
    expect(grants).toHaveLength(1);
    expect(readGrantHeader(grants[0])!.recipients).toEqual([bob.pubkey]);
    expect(readGrantHeader(grants[0])!.epochId).toBe(sendEpochOf(SPACE)!.info.id);

    // History policy "epoch": Bob reads everything since the last key change.
    const bobsKey = await keyOf(bob, grants[0]);
    expect(openSealedSpaceEvent(before, bobsKey).content).toBe("before bob joined");

    // A second pass has nothing left to do.
    h.published.length = 0;
    await reconcileSpaceKeys(SPACE);
    expect(h.published).toHaveLength(0);
  });

  it("rotates when a member is removed; their key fails on what follows", async () => {
    setRoster([me.pubkey, bob.pubkey, carol.pubkey]);
    await reconcileSpaceKeys(SPACE);
    await settle();
    const [firstGrant] = publishedOfKind(4291);
    const carolsKey = await keyOf(carol, firstGrant);
    const epoch0 = sendEpochOf(SPACE)!.info;
    const before = await sendChat("carol is still here");
    expect(openSealedSpaceEvent(before, carolsKey).content).toBe("carol is still here");

    // Carol is kicked. The stored roster still lists her (it lags the kick).
    h.published.length = 0;
    await reconcileSpaceKeys(SPACE, { exclude: [carol.pubkey] });
    await settle();

    const epoch1 = sendEpochOf(SPACE)!.info;
    expect(epoch1.seq).toBe(epoch0.seq + 1);
    expect(epoch1.prev).toBe(epoch0.id);
    const [rotation] = publishedOfKind(4291);
    expect(readGrantHeader(rotation)!.epochId).toBe(epoch1.id);
    expect(readGrantHeader(rotation)!.recipients.sort()).toEqual([me.pubkey, bob.pubkey].sort());
    await expect(openSpaceKeyGrant(rotation, carol.pubkey, carol.decrypt)).rejects.toMatchObject({ code: "not-recipient" });

    const after = await sendChat("carol must not read this");
    expect(readGrantHeader(rotation)!.epochId).toBe(after.tags.find((t) => t[0] === "epoch")![1]);
    expect(() => openSealedSpaceEvent(after, carolsKey)).toThrow(SpaceE2eeError);
    expect(openSealedSpaceEvent(after, await keyOf(bob, rotation)).content).toBe("carol must not read this");
    // Everyone who was there keeps the old epoch readable.
    expect(chatIn().map((e) => e.content)).toEqual(["carol is still here", "carol must not read this"]);

    // A later pass over the still-stale roster must not hand her the new key.
    h.published.length = 0;
    await reconcileSpaceKeys(SPACE);
    await settle();
    expect(publishedOfKind(4291)).toHaveLength(0);
  });

  it("rotates when a key holder leaves on their own", async () => {
    setRoster([me.pubkey, bob.pubkey]);
    await reconcileSpaceKeys(SPACE);
    await settle();
    const seq = sendEpochOf(SPACE)!.info.seq;
    h.published.length = 0;

    setRoster([me.pubkey]);
    await reconcileSpaceKeys(SPACE);
    await settle();
    expect(sendEpochOf(SPACE)!.info.seq).toBe(seq + 1);
    expect(readGrantHeader(publishedOfKind(4291)[0])!.recipients).toEqual([me.pubkey]);
  });

  it("gives a member who joins after a rotation the new epoch only", async () => {
    setRoster([me.pubkey, bob.pubkey]);
    await reconcileSpaceKeys(SPACE);
    const old = await sendChat("before the rotation");
    await reconcileSpaceKeys(SPACE, { exclude: [bob.pubkey] });
    setRoster([me.pubkey]);
    const current = await sendChat("after the rotation");
    await settle();
    h.published.length = 0;

    setRoster([me.pubkey, dave.pubkey]);
    await reconcileSpaceKeys(SPACE);
    await settle();
    const grants = publishedOfKind(4291);
    expect(grants).toHaveLength(1);
    const davesKey = await keyOf(dave, grants[0]);
    expect(openSealedSpaceEvent(current, davesKey).content).toBe("after the rotation");
    expect(() => openSealedSpaceEvent(old, davesKey)).toThrow(SpaceE2eeError);
  });

  it("does nothing on a roster that does not include this account, or when not a manager", async () => {
    setRoster([bob.pubkey, carol.pubkey]);
    await reconcileSpaceKeys(SPACE);
    expect(h.published).toHaveLength(0);
  });

  it("acts on the authority's roster, not the store's cached copy", async () => {
    setRoster([me.pubkey, bob.pubkey, carol.pubkey]);
    await reconcileSpaceKeys(SPACE);
    await settle();
    const seq = sendEpochOf(SPACE)!.info.seq;
    h.published.length = 0;

    // The store's copy is a session old and lists only this account. Acting
    // on it would rotate Bob and Carol out. The authority still lists them.
    setRoster([me.pubkey]);
    _resetKeyReconcile(async () => [me.pubkey, bob.pubkey, carol.pubkey]);
    await reconcileSpaceKeys(SPACE);
    await settle();
    expect(sendEpochOf(SPACE)!.info.seq).toBe(seq);
    expect(h.published).toHaveLength(0);
  });

  it("does nothing when the authority's roster can't be fetched", async () => {
    setRoster([me.pubkey, bob.pubkey]);
    _resetKeyReconcile(async () => null);
    await reconcileSpaceKeys(SPACE);
    expect(h.published).toHaveLength(0);
  });
});

describe("history policy 'full'", () => {
  it("hands a new member every epoch, oldest first", async () => {
    const s = space();
    await prepareFirstEpoch(s, "full");
    store.dispatch(addSpace(s));
    await publishFirstEpoch(s);
    setRoster([me.pubkey, bob.pubkey]);
    await reconcileSpaceKeys(SPACE);
    const old = await sendChat("epoch zero");
    await reconcileSpaceKeys(SPACE, { exclude: [bob.pubkey] });
    setRoster([me.pubkey]);
    const current = await sendChat("epoch one");
    await settle();
    h.published.length = 0;

    setRoster([me.pubkey, dave.pubkey]);
    await reconcileSpaceKeys(SPACE);
    await settle();
    const grants = publishedOfKind(4291);
    expect(grants).toHaveLength(2);
    const keys = await Promise.all(grants.map(async (g) => (await openSpaceKeyGrant(g, dave.pubkey, dave.decrypt)).key));
    expect(openSealedSpaceEvent(old, keys[0]).content).toBe("epoch zero");
    expect(openSealedSpaceEvent(current, keys[1]).content).toBe("epoch one");
  });
});

describe("receiving keys (member)", () => {
  const key0 = generateEpochKey();

  beforeEach(() => {
    store.dispatch(
      addSpace(space({ creatorPubkey: alice.pubkey, adminPubkeys: [alice.pubkey], memberPubkeys: [alice.pubkey, me.pubkey] })),
    );
  });

  it("accepts the creator's grant, marks the space encrypted and stores the key", async () => {
    expect(store.getState().spaceE2ee.spaces[SPACE]).toBeUndefined();
    await processIncomingEvent(grantFrom(alice, key0, [alice.pubkey, me.pubkey]), HOST);
    await settle();

    expect(store.getState().spaceE2ee.spaces[SPACE].root).toBe(alice.pubkey);
    expect(bytesToHex(getEpochKey(SPACE, epochIdOf(key0))!)).toBe(bytesToHex(key0));
    expect(h.keychain.get(spaceKeySlot(me.pubkey, SPACE))).toContain(bytesToHex(key0));
    expect(JSON.stringify(store.getState())).not.toContain(bytesToHex(key0));
    expect(isSpaceKeyManager(SPACE)).toBe(false);
  });

  it("parks sealed events that arrive before their key and releases them when it comes", async () => {
    await processIncomingEvent(sealedFrom(alice, key0, "you'll see this once you have the key"), HOST);
    expect(chatIn()).toHaveLength(0);

    await processIncomingEvent(grantFrom(alice, key0, [me.pubkey]), HOST);
    await settle();
    expect(chatIn().map((e) => e.content)).toEqual(["you'll see this once you have the key"]);
  });

  it("learns a space is encrypted from a grant it is not a recipient of", async () => {
    expect(await deliverGrant(grantFrom(alice, key0, [alice.pubkey]))).toBe("not-recipient");
    expect(store.getState().spaceE2ee.spaces[SPACE]).toBeDefined();
    expect(sendEpochOf(SPACE)).toBeNull();
    // From here on plaintext can't be posted there.
    await expect(signAndPublish(buildChatMessage(me.pubkey, SPACE, "x", undefined, CHANNEL), [HOST])).rejects.toThrow();
  });

  it("ignores a grant from a member who is not an admin", async () => {
    expect(await deliverGrant(grantFrom(bob, key0, [me.pubkey]))).toBe("unauthorized");
    expect(store.getState().spaceE2ee.spaces[SPACE]).toBeUndefined();
    expect(getEpochKey(SPACE, epochIdOf(key0))).toBeUndefined();
  });

  it("after the first key, trusts the epoch's managers and not the server's admin list", async () => {
    await deliverGrant(grantFrom(alice, key0, [me.pubkey], { managers: [alice.pubkey, bob.pubkey] }));

    // The server now claims Carol is an admin. She is not a manager of the
    // newest epoch, so her "rotation" is ignored.
    store.dispatch(
      addSpace(space({ creatorPubkey: alice.pubkey, adminPubkeys: [alice.pubkey, carol.pubkey], memberPubkeys: [me.pubkey] })),
    );
    const forged = generateEpochKey();
    expect(
      await deliverGrant(
        grantFrom(carol, forged, [me.pubkey], { seq: 1, prev: epochIdOf(key0), managers: [carol.pubkey] }),
      ),
    ).toBe("unauthorized");
    expect(sendEpochOf(SPACE)!.info.id).toBe(epochIdOf(key0));

    // Bob IS a manager of the newest epoch: his rotation is accepted.
    const key1 = generateEpochKey();
    expect(
      await deliverGrant(
        grantFrom(bob, key1, [me.pubkey], { seq: 1, prev: epochIdOf(key0), managers: [alice.pubkey, bob.pubkey] }),
      ),
    ).toBe("accepted");
    expect(sendEpochOf(SPACE)!.info.id).toBe(epochIdOf(key1));
    // The old epoch stays readable.
    expect(getEpochKey(SPACE, epochIdOf(key0))).toBeDefined();
  });

  it("rejects a first grant from a listed admin whose payload does not name them", async () => {
    store.dispatch(
      addSpace(space({ creatorPubkey: alice.pubkey, adminPubkeys: [alice.pubkey, carol.pubkey], memberPubkeys: [me.pubkey] })),
    );
    expect(await deliverGrant(grantFrom(carol, key0, [me.pubkey], { managers: [alice.pubkey] }))).toBe("unauthorized");
    expect(sendEpochOf(SPACE)).toBeNull();
  });

  it("sends with the newest epoch and breaks a same-seq tie by the smaller id", async () => {
    await deliverGrant(grantFrom(alice, key0, [me.pubkey]));
    const a = generateEpochKey();
    const b = generateEpochKey();
    for (const k of [a, b]) {
      await deliverGrant(grantFrom(alice, k, [me.pubkey], { seq: 1, prev: epochIdOf(key0) }));
    }
    const expected = [epochIdOf(a), epochIdOf(b)].sort()[0];
    expect(sendEpochOf(SPACE)!.info.id).toBe(expected);
  });

  it("keeps a grant it could not open because the signer was away, and opens it later", async () => {
    h.signerAway = true;
    expect(await deliverGrant(grantFrom(alice, key0, [me.pubkey]))).toBe("retry");
    expect(sendEpochOf(SPACE)).toBeNull();
    h.signerAway = false;
    await retryPendingGrants();
    expect(sendEpochOf(SPACE)!.info.id).toBe(epochIdOf(key0));
  });

  it("asks the signer once per epoch, however many grants name it", async () => {
    const nip44 = await import("@/lib/nostr/nip44");
    const spy = vi.spyOn(nip44, "nip44Decrypt");
    await Promise.all([
      deliverGrant(grantFrom(alice, key0, [me.pubkey])),
      deliverGrant(grantFrom(alice, key0, [me.pubkey, bob.pubkey])),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("restart", () => {
  const key0 = generateEpochKey();

  async function restart(): Promise<void> {
    await settle();
    clearSpaceE2eeSession();
    clearSealedChatSession();
    store.dispatch(resetAll());
    resetEventPipelineCaches();
    store.dispatch(login({ pubkey: me.pubkey, signerType: "nip07" }));
    store.dispatch(setFeatureEnabled({ feature: FEATURE_E2EE_SPACES, enabled: true }));
    store.dispatch(
      addSpace(space({ creatorPubkey: alice.pubkey, adminPubkeys: [alice.pubkey], memberPubkeys: [alice.pubkey, me.pubkey] })),
    );
    await ensureSpaceE2eeHydrated();
  }

  beforeEach(async () => {
    store.dispatch(
      addSpace(space({ creatorPubkey: alice.pubkey, adminPubkeys: [alice.pubkey], memberPubkeys: [alice.pubkey, me.pubkey] })),
    );
    await deliverGrant(grantFrom(alice, key0, [me.pubkey]));
  });

  it("restores access from the stored key without touching the signer", async () => {
    const nip44 = await import("@/lib/nostr/nip44");
    const spy = vi.spyOn(nip44, "nip44Decrypt");
    await restart();
    expect(store.getState().spaceE2ee.spaces[SPACE].root).toBe(alice.pubkey);
    expect(sendEpochOf(SPACE)!.info.id).toBe(epochIdOf(key0));
    await processIncomingEvent(sealedFrom(alice, key0, "still readable"), HOST);
    expect(chatIn().map((e) => e.content)).toEqual(["still readable"]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("with the key cache gone, stays marked encrypted and re-derives the key from the grant", async () => {
    h.keychain.clear();
    await restart();
    expect(store.getState().spaceE2ee.spaces[SPACE]).toBeDefined();
    expect(sendEpochOf(SPACE)).toBeNull();
    await expect(signAndPublish(buildChatMessage(me.pubkey, SPACE, "x", undefined, CHANNEL), [HOST])).rejects.toThrow();

    await processIncomingEvent(grantFrom(alice, key0, [me.pubkey]), HOST);
    await settle();
    expect(sendEpochOf(SPACE)!.info.id).toBe(epochIdOf(key0));
  });

  it("ignores a stored key that does not match its epoch id", async () => {
    const slot = spaceKeySlot(me.pubkey, SPACE);
    h.keychain.set(slot, JSON.stringify({ v: 1, keys: { [epochIdOf(key0)]: bytesToHex(generateEpochKey()) } }));
    await restart();
    expect(sendEpochOf(SPACE)).toBeNull();
  });
});
