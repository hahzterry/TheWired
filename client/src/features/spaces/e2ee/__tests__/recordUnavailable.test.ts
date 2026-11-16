import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { UnsignedEvent } from "@/types/nostr";
import type { Space } from "@/types/space";

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
//
// No assertion here depends on wall-clock time or scheduler timing: the
// record's wait is driven with fake timers (setTimeout only, so IndexedDB
// is untouched), and posting is shown not to wait by never reading storage.

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
  vi.useRealTimers();
  for (const release of h.release) release(undefined);
  _setRecordReadTimeoutForTest();
  store.dispatch(resetAll());
  setActivePubkey(null);
  vi.restoreAllMocks();
});

describe("posting while local storage doesn't answer", () => {
  it("posts into a plain space without reading storage", async () => {
    h.read = "hang";
    await expect(signAndPublish(chat(PLAIN, "hello"), [HOST])).resolves.toMatchObject({ kind: 9, content: "hello" });
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

/** Settle-state of a promise, readable synchronously after microtasks. */
function track(p: Promise<unknown>): { settled: () => "pending" | "resolved" | "rejected"; error: () => unknown } {
  let state: "pending" | "resolved" | "rejected" = "pending";
  let error: unknown;
  p.then(
    () => { state = "resolved"; },
    (e) => { state = "rejected"; error = e; },
  );
  return { settled: () => state, error: () => error };
}

describe("the keyring's record read", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  it("gives up when the wait runs out, not before, instead of hanging", async () => {
    h.read = "hang";
    const attempt = track(ensureSpaceE2eeRecord());
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
    expect(attempt.settled()).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt.settled()).toBe("rejected");
    expect(attempt.error()).toBeInstanceOf(SpaceE2eeRecordUnavailableError);
    expect(selectSpaceE2eeLoaded(store.getState())).toBe(false);
  });

  it("starts a fresh read on the next attempt instead of joining the stuck one", async () => {
    h.read = "hang";
    const first = track(ensureSpaceE2eeRecord());
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(first.settled()).toBe("rejected");
    const second = track(ensureSpaceE2eeRecord());
    expect(h.reads).toBe(2);
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(second.settled()).toBe("rejected");
  });

  it("starts a fresh read even when retried from inside the refusal", async () => {
    // The edge a clock comparison got wrong: a retry made the moment the
    // first attempt is refused must not join the read that just ran out.
    h.read = "hang";
    const retried = track(ensureSpaceE2eeRecord().catch(() => ensureSpaceE2eeRecord()));
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(h.reads).toBe(2);
    expect(retried.settled()).toBe("pending");
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(retried.settled()).toBe("rejected");
  });

  it("joins the read in flight while its wait runs, and refuses every caller together", async () => {
    h.read = "hang";
    const first = track(ensureSpaceE2eeRecord());
    await vi.advanceTimersByTimeAsync(TIMEOUT / 2);
    const second = track(ensureSpaceE2eeRecord());
    expect(h.reads).toBe(1);
    await vi.advanceTimersByTimeAsync(TIMEOUT / 2 - 1);
    expect([first.settled(), second.settled()]).toEqual(["pending", "pending"]);
    await vi.advanceTimersByTimeAsync(1);
    expect([first.settled(), second.settled()]).toEqual(["rejected", "rejected"]);
  });

  it("loads the record when storage answers late", async () => {
    h.read = "hang";
    const attempt = track(ensureSpaceE2eeRecord());
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(attempt.settled()).toBe("rejected");
    vi.useRealTimers();
    h.read = "answer";
    for (const release of h.release.splice(0)) release(undefined);
    await vi.waitFor(() => expect(selectSpaceE2eeLoaded(store.getState())).toBe(true));
  });

  it("retries after a read that failed outright", async () => {
    h.read = "fail";
    await expect(ensureSpaceE2eeRecord()).rejects.toBeInstanceOf(SpaceE2eeRecordUnavailableError);
    h.read = "answer";
    vi.useRealTimers();
    await expect(ensureSpaceE2eeRecord()).resolves.toBeUndefined();
    expect(h.reads).toBe(2);
  });
});
