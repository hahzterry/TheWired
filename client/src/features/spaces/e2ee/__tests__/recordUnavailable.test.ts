import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { UnsignedEvent } from "@/types/nostr";
import type { Space } from "@/types/space";

// The publish guard fails closed while the account's record of encrypted
// spaces is not loaded (docs/E2EE_SPACES.md §6.1). When local storage doesn't
// answer (an IndexedDB open blocked by another tab), that refusal must be
// prompt and explained, never a hang, and posting must recover on its own.

const h = vi.hoisted(() => ({
  sk: null as Uint8Array | null,
  signed: [] as unknown[],
  /** How the record read behaves: answer, never settle, or fail. */
  read: "answer" as "answer" | "hang" | "fail",
  release: [] as Array<(v: unknown) => void>,
  reads: 0,
}));

vi.mock("@/lib/db/userStateStore", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db/userStateStore")>();
  return {
    ...real,
    getUserState: async (key: string) => {
      if (key !== "e2ee_spaces") return real.getUserState(key);
      h.reads++;
      if (h.read === "hang") return new Promise((resolve) => h.release.push(resolve));
      if (h.read === "fail") throw new Error("storage error");
      return real.getUserState(key);
    },
  };
});
vi.mock("@/lib/nostr/loginFlow", () => ({
  getSigner: () => ({
    getPublicKey: async () => getPublicKey(h.sk!),
    signEvent: async (unsigned: UnsignedEvent) => {
      h.signed.push(unsigned);
      return finalizeEvent(unsigned as never, h.sk!);
    },
  }),
  getSignerTimeoutMs: () => 5_000,
}));
vi.mock("@/lib/nostr/publishOutbox", () => ({ publishOutbox: { record: vi.fn() } }));

import { store, resetAll } from "@/store";
import { login } from "@/store/slices/identitySlice";
import { addSpace } from "@/store/slices/spacesSlice";
import { selectSpaceE2eeLoaded } from "@/store/slices/spaceE2eeSlice";
import { clearAllUserState, setActivePubkey } from "@/lib/db/userStateStore";
import { resetEventPipelineCaches } from "@/lib/nostr/eventPipeline";
import { relayManager } from "@/lib/nostr/relayManager";
import { signAndPublish } from "@/lib/nostr/publish";
import { buildChatMessage } from "@/lib/nostr/eventBuilder";
import {
  SpaceE2eeRecordUnavailableError,
  _setRecordReadTimeoutForTest,
  ensureSpaceE2eeRecord,
  resetSpaceE2eeRecord,
} from "../e2eeRecord";

// Whether a space is encrypted is decided from its id (docs/E2EE_SPACES.md
// §5.4), so posting never waits on local storage. When storage doesn't
// answer (an IndexedDB open blocked by another tab), plain spaces work as
// usual, encrypted ones still refuse plaintext, and the keyring's own read of
// its record is bounded and recovers on its own.

const HOST = "wss://space.example";
const PLAIN = "plainspace";
const ENCRYPTED = "e2e1-" + "c0ffee00".repeat(4);
const TIMEOUT = 60;
const sk = generateSecretKey();
const me = getPublicKey(sk);

function space(id: string): Space {
  return {
    id,
    hostRelay: HOST,
    name: id,
    isPrivate: false,
    adminPubkeys: [me],
    memberPubkeys: [me],
    feedPubkeys: [],
    mode: "read-write",
    creatorPubkey: me,
    createdAt: 1,
  };
}

const chat = (spaceId: string, text: string) => buildChatMessage(me, spaceId, text, undefined, "chat");
const inSpace = (spaceId: string, kind: number): UnsignedEvent => ({ pubkey: me, created_at: 1, kind, tags: [["h", spaceId]], content: "" });

let published: unknown[] = [];

beforeEach(async () => {
  h.read = "answer";
  await clearAllUserState();
  h.sk = sk;
  h.signed = [];
  h.release = [];
  h.reads = 0;
  published = [];
  vi.spyOn(relayManager, "connect").mockImplementation(() => undefined as never);
  vi.spyOn(relayManager, "publish").mockImplementation((event: unknown) => {
    published.push(event);
    return 1;
  });
  store.dispatch(resetAll());
  resetSpaceE2eeRecord();
  resetEventPipelineCaches();
  _setRecordReadTimeoutForTest(TIMEOUT);
  setActivePubkey(me);
  store.dispatch(login({ pubkey: me, signerType: "nip07" }));
  store.dispatch(addSpace(space(PLAIN)));
  store.dispatch(addSpace(space(ENCRYPTED)));
});

afterEach(() => {
  for (const release of h.release) release(undefined);
  _setRecordReadTimeoutForTest();
  store.dispatch(resetAll());
  setActivePubkey(null);
  vi.restoreAllMocks();
});

describe("posting while local storage doesn't answer", () => {
  it("posts into a plain space at once, without reading storage", async () => {
    h.read = "hang";
    const started = Date.now();
    await expect(signAndPublish(chat(PLAIN, "hello"), [HOST])).resolves.toMatchObject({ kind: 9, content: "hello" });
    expect(Date.now() - started).toBeLessThan(TIMEOUT);
    expect(h.reads).toBe(0);
    expect(published).toHaveLength(1);
  });

  it("refuses plaintext into an encrypted space at once, and signs nothing", async () => {
    h.read = "hang";
    await expect(signAndPublish(chat(ENCRYPTED, "would leak"), [HOST])).rejects.toThrow(/end-to-end encrypted/);
    expect(h.signed).toHaveLength(0);
    expect(published).toHaveLength(0);
    expect(h.reads).toBe(0);
  });

  it("still lets the kinds that stay in the clear through, in an encrypted space", async () => {
    h.read = "hang";
    for (const kind of [5, 9021, 9022, 1984, 9000, 9001, 9005, 9007, 30078, 10312, 30312]) {
      await expect(signAndPublish(inSpace(ENCRYPTED, kind), [HOST])).resolves.toMatchObject({ kind });
    }
    expect(h.signed.every((u) => (u as UnsignedEvent).kind !== 9)).toBe(true);
  });
});

describe("the keyring's record read", () => {
  it("gives up within the timeout instead of hanging", async () => {
    h.read = "hang";
    const started = Date.now();
    await expect(ensureSpaceE2eeRecord()).rejects.toBeInstanceOf(SpaceE2eeRecordUnavailableError);
    expect(Date.now() - started).toBeLessThan(TIMEOUT + 500);
    expect(selectSpaceE2eeLoaded(store.getState())).toBe(false);
  });

  it("starts a fresh read on the next attempt instead of joining the stuck one", async () => {
    h.read = "hang";
    await expect(ensureSpaceE2eeRecord()).rejects.toBeInstanceOf(SpaceE2eeRecordUnavailableError);
    await expect(ensureSpaceE2eeRecord()).rejects.toBeInstanceOf(SpaceE2eeRecordUnavailableError);
    expect(h.reads).toBe(2);
  });

  it("loads the record when storage answers late", async () => {
    h.read = "hang";
    await expect(ensureSpaceE2eeRecord()).rejects.toBeInstanceOf(SpaceE2eeRecordUnavailableError);
    h.read = "answer";
    for (const release of h.release.splice(0)) release(undefined);
    await vi.waitFor(() => expect(selectSpaceE2eeLoaded(store.getState())).toBe(true));
  });

  it("retries after a read that failed outright", async () => {
    h.read = "fail";
    await expect(ensureSpaceE2eeRecord()).rejects.toBeInstanceOf(SpaceE2eeRecordUnavailableError);
    h.read = "answer";
    await expect(ensureSpaceE2eeRecord()).resolves.toBeUndefined();
    expect(h.reads).toBe(2);
  });
});
