import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { getConversationKey, decrypt as nip44v2Decrypt } from "nostr-tools/nip44";
import type { NostrEvent, UnsignedEvent } from "@/types/nostr";
import type { Space } from "@/types/space";

// The controller's roster watch for a space this account manages
// (docs/E2EE_SPACES.md §5.2–5.3): when it hands out keys on its own, and when
// it deliberately does not.

const h = vi.hoisted(() => ({ keychain: new Map<string, string>(), sk: null as Uint8Array | null }));

vi.mock("@/lib/nostr/secretStore", () => ({
  isSecretPersistEnabled: () => true,
  getSecret: async (k: string) => h.keychain.get(k) ?? null,
  setSecret: async (k: string, v: string) => void h.keychain.set(k, v),
  deleteSecret: async (k: string) => void h.keychain.delete(k),
}));
vi.mock("@/lib/nostr/loginFlow", () => ({
  getSigner: () => ({
    getPublicKey: async () => getPublicKey(h.sk!),
    signEvent: async (unsigned: UnsignedEvent) => finalizeEvent(unsigned as never, h.sk!),
  }),
  getSignerTimeoutMs: () => 5_000,
}));
vi.mock("@/lib/nostr/nip44", () => ({
  nip44Encrypt: async () => "",
  nip44Decrypt: async (peer: string, ct: string) => nip44v2Decrypt(ct, getConversationKey(h.sk!, peer)),
}));
vi.mock("@/lib/nostr/publishOutbox", () => ({ publishOutbox: { record: vi.fn() } }));

import { readGrantHeader } from "@ishtarservices/core";
import { store, resetAll } from "@/store";
import { login } from "@/store/slices/identitySlice";
import { addSpace, setActiveSpace, updateSpaceMembers } from "@/store/slices/spacesSlice";
import { setFeatureEnabled, FEATURE_E2EE_SPACES } from "@/store/slices/featuresSlice";
import { clearAllUserState, setActivePubkey } from "@/lib/db/userStateStore";
import { resetEventPipelineCaches } from "@/lib/nostr/eventPipeline";
import { relayManager } from "@/lib/nostr/relayManager";
import { subscriptionManager } from "@/lib/nostr/subscriptionManager";
import { startSpaceE2ee, stopSpaceE2ee } from "../e2eeController";
import { _resetKeyReconcile } from "../keyReconcile";
import { prepareFirstEpoch, publishFirstEpoch, sendEpochOf } from "../spaceKeyring";

const HOST = "wss://space.example";
const SPACE = "managed01";
const meSk = generateSecretKey();
const me = getPublicKey(meSk);
const bob = getPublicKey(generateSecretKey());

const space: Space = {
  id: SPACE,
  hostRelay: HOST,
  name: "Managed",
  isPrivate: false,
  adminPubkeys: [me],
  memberPubkeys: [me],
  feedPubkeys: [],
  mode: "read-write",
  creatorPubkey: me,
  createdAt: 1,
  spaceType: "nip29-native",
};

let published: NostrEvent[] = [];
const grants = () => published.filter((e) => e.kind === 4291);

/** Let queued promise work (IndexedDB, keychain) finish under fake timers. */
async function drain(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(async () => {
  await clearAllUserState();
  h.sk = meSk;
  h.keychain.clear();
  published = [];
  vi.spyOn(relayManager, "connect").mockImplementation(() => undefined as never);
  vi.spyOn(relayManager, "publish").mockImplementation((event: unknown) => {
    published.push(event as NostrEvent);
    return 1;
  });
  let n = 0;
  vi.spyOn(subscriptionManager, "subscribe").mockImplementation(() => `sub-${++n}`);
  vi.spyOn(subscriptionManager, "close").mockImplementation(() => undefined as never);
  store.dispatch(resetAll());
  resetEventPipelineCaches();
  // The authority's roster, for these tests, is whatever the store holds now.
  _resetKeyReconcile(async (sp) => store.getState().spaces.list.find((x) => x.id === sp.id)?.memberPubkeys ?? null);
  setActivePubkey(me);
  store.dispatch(login({ pubkey: me, signerType: "nip07" }));
  store.dispatch(setFeatureEnabled({ feature: FEATURE_E2EE_SPACES, enabled: true }));
  await prepareFirstEpoch(space, "epoch");
  store.dispatch(addSpace(space));
  await publishFirstEpoch(space);
  await new Promise((res) => setTimeout(res, 30));
  published = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  startSpaceE2ee();
  await drain(50);
});

afterEach(async () => {
  await drain(20_000);
  stopSpaceE2ee();
  vi.useRealTimers();
  store.dispatch(resetAll());
  setActivePubkey(null);
  vi.restoreAllMocks();
});

describe("roster watch", () => {
  it("does not act on the roster it starts with (it may be a stale cache)", async () => {
    await drain(10_000);
    expect(grants()).toHaveLength(0);
  });

  it("hands the key to a member who appears on a fresh roster, after a debounce", async () => {
    store.dispatch(updateSpaceMembers({ spaceId: SPACE, members: [me, bob] }));
    await drain(1_000);
    expect(grants()).toHaveLength(0);
    await drain(1_000);
    expect(grants()).toHaveLength(1);
    expect(readGrantHeader(grants()[0])!.recipients).toEqual([bob]);
  });

  it("coalesces a burst of roster updates into one pass", async () => {
    const carol = getPublicKey(generateSecretKey());
    store.dispatch(updateSpaceMembers({ spaceId: SPACE, members: [me, bob] }));
    await drain(500);
    store.dispatch(updateSpaceMembers({ spaceId: SPACE, members: [me, bob, carol] }));
    await drain(3_000);
    expect(grants()).toHaveLength(1);
    expect(readGrantHeader(grants()[0])!.recipients.sort()).toEqual([bob, carol].sort());
  });

  it("rotates when a key holder drops off the roster", async () => {
    store.dispatch(updateSpaceMembers({ spaceId: SPACE, members: [me, bob] }));
    await drain(3_000);
    const before = sendEpochOf(SPACE)!.info;
    store.dispatch(updateSpaceMembers({ spaceId: SPACE, members: [me] }));
    await drain(3_000);
    const after = sendEpochOf(SPACE)!.info;
    expect(after.seq).toBe(before.seq + 1);
    expect(readGrantHeader(grants()[grants().length - 1])!.recipients).toEqual([me]);
  });

  it("checks a managed space's keys a few seconds after it is opened", async () => {
    // Bob is already on the roster this session starts with (he joined while
    // no manager was online), so no roster CHANGE will ever announce him.
    // (Restarted on real timers: reloading the record goes through IndexedDB.)
    stopSpaceE2ee();
    vi.useRealTimers();
    store.dispatch(updateSpaceMembers({ spaceId: SPACE, members: [me, bob] }));
    startSpaceE2ee();
    await new Promise((res) => setTimeout(res, 50));
    expect(sendEpochOf(SPACE)).not.toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await drain(10_000);
    expect(grants()).toHaveLength(0);

    store.dispatch(setActiveSpace(SPACE));
    await drain(4_000);
    expect(grants()).toHaveLength(0);
    await drain(2_000);
    expect(grants()).toHaveLength(1);
    expect(readGrantHeader(grants()[0])!.recipients).toEqual([bob]);
  });

  it("does nothing with the feature off", async () => {
    store.dispatch(setFeatureEnabled({ feature: FEATURE_E2EE_SPACES, enabled: false }));
    store.dispatch(updateSpaceMembers({ spaceId: SPACE, members: [me, bob] }));
    await drain(10_000);
    expect(grants()).toHaveLength(0);
  });
});
