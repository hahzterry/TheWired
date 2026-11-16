// The non-secret record of which spaces are end-to-end encrypted, for the
// logged-in account (docs/E2EE_SPACES.md §5.5). Deliberately tiny and free of
// crypto imports: it is on the startup path and on every publish path.
//
// It is loaded from IndexedDB as soon as an account is active, BEFORE and
// independently of the keychain: "this space is encrypted" must be known even
// while its keys are still loading (or the OS is waiting on a keychain prompt),
// or a message typed in that window would go out in the clear.

import { store } from "@/store";
import {
  hydrateSpaceE2ee,
  isSpaceE2eeLoadedFor,
  resetSpaceE2ee,
  type EncryptedSpaceState,
} from "@/store/slices/spaceE2eeSlice";
import { getActivePubkey, getUserState, saveUserState } from "@/lib/db/userStateStore";
import type { SpaceEpochInfo } from "@ishtarservices/shared-types";

/** userStateStore key of the record. */
export const SPACE_E2EE_STATE_KEY = "e2ee_spaces";

const HEX64_RE = /^[0-9a-f]{64}$/;

export function sanitizeSpaceE2eeRecord(raw: unknown): Record<string, EncryptedSpaceState> {
  const out: Record<string, EncryptedSpaceState> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [spaceId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Partial<EncryptedSpaceState>;
    const epochs = Array.isArray(v.epochs)
      ? v.epochs.filter(
          (e): e is SpaceEpochInfo =>
            !!e && typeof e.id === "string" && typeof e.seq === "number" && Array.isArray(e.managers),
        )
      : [];
    const holders: Record<string, string[]> = {};
    if (v.holders && typeof v.holders === "object") {
      for (const [epochId, list] of Object.entries(v.holders)) {
        if (Array.isArray(list)) holders[epochId] = list.filter((pk) => typeof pk === "string" && HEX64_RE.test(pk));
      }
    }
    const root = typeof v.root === "string" && HEX64_RE.test(v.root) ? v.root : null;
    const rootSalt = root && typeof v.rootSalt === "string" && /^[0-9a-f]{32}$/.test(v.rootSalt) ? v.rootSalt : null;
    out[spaceId] = { root, rootSalt, epochs, holders };
  }
  return out;
}

/** How long a caller waits for the record before giving up on this attempt. */
export const RECORD_READ_TIMEOUT_MS = 4_000;
let readTimeoutMs = RECORD_READ_TIMEOUT_MS;

/** Test-only: shorten the wait. */
export function _setRecordReadTimeoutForTest(ms: number = RECORD_READ_TIMEOUT_MS): void {
  readTimeoutMs = ms;
}

/** Why the keys of encrypted spaces could not be loaded. */
export const RECORD_UNAVAILABLE_MESSAGE =
  "This app's local storage isn't answering, so the keys of your encrypted spaces can't be loaded. " +
  "Close other tabs or windows of The Wired, or reload.";

/** The record could not be read within the wait (local storage not
 *  answering: an IndexedDB open blocked by another tab, a stuck disk). */
export class SpaceE2eeRecordUnavailableError extends Error {
  constructor() {
    super(RECORD_UNAVAILABLE_MESSAGE);
    this.name = "SpaceE2eeRecordUnavailableError";
  }
}

interface Read {
  account: string;
  promise: Promise<void>;
  startedAt: number;
}

/** The read in flight, if any. Joined only while it is younger than the wait:
 *  an older one may never settle (a blocked IndexedDB open), so the next
 *  attempt starts a fresh read instead of queueing behind it. */
let loading: Read | null = null;

/** Is the logged-in account's record in the store? */
export function isSpaceE2eeRecordLoaded(): boolean {
  return isSpaceE2eeLoadedFor(store.getState());
}

function startRead(account: string): Read {
  const promise = (async () => {
    // Per-account rows are keyed by the storage layer's active pubkey, which
    // the login flow sets before the store's. Never read under another
    // account's prefix (or none).
    if (getActivePubkey() !== account) throw new Error("account storage is not ready");
    const raw = await getUserState(SPACE_E2EE_STATE_KEY);
    if (getActivePubkey() !== account || store.getState().identity.pubkey !== account) return;
    // A read that settles late (storage answered after the wait) still loads
    // the record, unless another read got there first.
    if (!isSpaceE2eeRecordLoaded()) {
      store.dispatch(hydrateSpaceE2ee({ account, spaces: sanitizeSpaceE2eeRecord(raw) }));
    }
  })();
  const read: Read = { account, promise, startedAt: Date.now() };
  const clear = () => {
    if (loading === read) loading = null;
  };
  promise.then(clear, clear);
  return read;
}

/**
 * Load the logged-in account's record into the store. Safe to call from
 * anywhere, any number of times; at most one read in flight per account.
 *
 * Settles within RECORD_READ_TIMEOUT_MS. Rejects when the record could not be
 * read (SpaceE2eeRecordUnavailableError when storage did not answer in time):
 * callers that are about to sign must then refuse, not assume there is
 * nothing to protect. The next call tries again; a read that answers late
 * still loads the record, so posting recovers on its own.
 */
export function ensureSpaceE2eeRecord(): Promise<void> {
  const account = store.getState().identity.pubkey;
  if (!account) return Promise.resolve();
  if (isSpaceE2eeRecordLoaded()) return Promise.resolve();

  const now = Date.now();
  if (!loading || loading.account !== account || now - loading.startedAt >= readTimeoutMs) {
    loading = startRead(account);
  }
  const read = loading;

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SpaceE2eeRecordUnavailableError());
    }, Math.max(0, readTimeoutMs - (now - read.startedAt)));
    read.promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (err instanceof Error && err.message !== "account storage is not ready") {
          reject(new SpaceE2eeRecordUnavailableError());
          return;
        }
        reject(err);
      },
    );
  });
}

/**
 * Write the record for `account`. A no-op unless that account is both logged
 * in and the one whose record is in the store: after an await the active
 * account may have changed, and writing then would store one account's record
 * (or an empty one) under another's name.
 */
export function persistSpaceE2eeRecord(account: string): void {
  const state = store.getState();
  if (state.identity.pubkey !== account || state.spaceE2ee.account !== account) return;
  if (getActivePubkey() !== account) return;
  saveUserState(SPACE_E2EE_STATE_KEY, state.spaceE2ee.spaces).catch(() => {});
}

/**
 * Logout or account switch: drop a record that is not the logged-in
 * account's. One already loaded for the account now logged in is kept (it may
 * have been loaded by a publish before the previous session was torn down).
 */
export function resetSpaceE2eeRecord(): void {
  const current = store.getState().identity.pubkey;
  if (loading && loading.account !== current) loading = null;
  const held = store.getState().spaceE2ee.account;
  if (held !== null && held !== current) store.dispatch(resetSpaceE2ee());
}
