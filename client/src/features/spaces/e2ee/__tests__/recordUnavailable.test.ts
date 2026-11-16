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
import { selectSpaceE2eeLoaded, selectSpaceE2eeRecordUnavailable } from "@/store/slices/spaceE2eeSlice";
import { clearAllUserState, setActivePubkey } from "@/lib/db/userStateStore";
import { resetEventPipelineCaches } from "@/lib/nostr/eventPipeline";
import { relayManager } from "@/lib/nostr/relayManager";
import { signAndPublish } from "@/lib/nostr/publish";
import { buildChatMessage } from "@/lib/nostr/eventBuilder";
import { _setRecordReadTimeoutForTest, resetSpaceE2eeRecord } from "../e2eeRecord";

const HOST = "wss://space.example";
const SPACE = "plainspace";
const TIMEOUT = 60;
const sk = generateSecretKey();
const me = getPublicKey(sk);

const space: Space = {
  id: SPACE,
  hostRelay: HOST,
  name: "Plain",
  isPrivate: false,
  adminPubkeys: [me],
  memberPubkeys: [me],
  feedPubkeys: [],
  mode: "read-write",
  creatorPubkey: me,
  createdAt: 1,
};

const chat = (text: string) => buildChatMessage(me, SPACE, text, undefined, "chat");
const inSpace = (kind: number): UnsignedEvent => ({ pubkey: me, created_at: 1, kind, tags: [["h", SPACE]], content: "" });

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
  store.dispatch(addSpace(space));
});

afterEach(() => {
  for (const release of h.release) release(undefined);
  _setRecordReadTimeoutForTest();
  store.dispatch(resetAll());
  setActivePubkey(null);
  vi.restoreAllMocks();
});

describe("record read that never answers", () => {
  it("refuses the post within the timeout, with an explanation, and signs nothing", async () => {
    h.read = "hang";
    const started = Date.now();
    await expect(signAndPublish(chat("hello"), [HOST])).rejects.toThrow(/local storage isn't answering/);
    expect(Date.now() - started).toBeLessThan(TIMEOUT + 500);
    expect(h.signed).toHaveLength(0);
    expect(published).toHaveLength(0);
    // The composer can explain it too.
    expect(selectSpaceE2eeLoaded(store.getState())).toBe(false);
    expect(selectSpaceE2eeRecordUnavailable(store.getState())).toBe(true);
  });

  it("starts a fresh read on the next attempt instead of joining the stuck one", async () => {
    h.read = "hang";
    await expect(signAndPublish(chat("one"), [HOST])).rejects.toThrow(/local storage/);
    await expect(signAndPublish(chat("two"), [HOST])).rejects.toThrow(/local storage/);
    expect(h.reads).toBe(2);
    expect(h.signed).toHaveLength(0);
  });

  it("recovers once storage answers late: the record loads and the next post goes through", async () => {
    h.read = "hang";
    await expect(signAndPublish(chat("too early"), [HOST])).rejects.toThrow(/local storage/);
    // The stuck read finally answers (the other tab was closed).
    h.read = "answer";
    for (const release of h.release.splice(0)) release(undefined);
    await vi.waitFor(() => expect(selectSpaceE2eeLoaded(store.getState())).toBe(true));
    expect(selectSpaceE2eeRecordUnavailable(store.getState())).toBe(false);
    await expect(signAndPublish(chat("now it works"), [HOST])).resolves.toMatchObject({ kind: 9, content: "now it works" });
    expect(h.signed).toHaveLength(1);
  });

  it("retries after a read that failed outright", async () => {
    h.read = "fail";
    await expect(signAndPublish(chat("x"), [HOST])).rejects.toThrow(/local storage/);
    h.read = "answer";
    await expect(signAndPublish(chat("y"), [HOST])).resolves.toMatchObject({ kind: 9 });
    expect(h.reads).toBe(2);
  });

  it("still lets the kinds that stay in the clear through", async () => {
    h.read = "hang";
    // Deletion, join, leave, report, NIP-29 management, layout, voice presence.
    for (const kind of [5, 9021, 9022, 1984, 9000, 9001, 9005, 9007, 30078, 10312, 30312]) {
      await expect(signAndPublish(inSpace(kind), [HOST])).resolves.toMatchObject({ kind });
    }
    // Nothing space-scoped that must be sealed was signed.
    expect(h.signed.every((u) => (u as UnsignedEvent).kind !== 9)).toBe(true);
  });

  it("leaves content that names no space alone", async () => {
    h.read = "hang";
    await expect(signAndPublish({ pubkey: me, created_at: 1, kind: 1, tags: [], content: "a note" }, [HOST])).resolves.toMatchObject({
      kind: 1,
    });
  });
});

describe("record loaded", () => {
  it("posts into a plain space as before", async () => {
    await expect(signAndPublish(chat("plain"), [HOST])).resolves.toMatchObject({ kind: 9, content: "plain" });
    expect(published).toHaveLength(1);
  });
});
