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
    out[spaceId] = { root: typeof v.root === "string" && HEX64_RE.test(v.root) ? v.root : null, epochs, holders };
  }
  return out;
}

let loading: { account: string; promise: Promise<void> } | null = null;

/** Is the logged-in account's record in the store? */
export function isSpaceE2eeRecordLoaded(): boolean {
  return isSpaceE2eeLoadedFor(store.getState());
}

/**
 * Load the logged-in account's record into the store. One read per account per
 * session; safe to call from anywhere, any number of times. Rejects when the
 * record could not be read: callers that are about to sign must then refuse,
 * not assume there is nothing to protect. A failed read is retried on the next
 * call.
 */
export function ensureSpaceE2eeRecord(): Promise<void> {
  const account = store.getState().identity.pubkey;
  if (!account) return Promise.resolve();
  if (isSpaceE2eeRecordLoaded()) return Promise.resolve();
  if (loading?.account === account) return loading.promise;

  const promise = (async () => {
    // Per-account rows are keyed by the storage layer's active pubkey, which
    // the login flow sets before the store's. Never read under another
    // account's prefix (or none).
    if (getActivePubkey() !== account) throw new Error("account storage is not ready");
    const raw = await getUserState(SPACE_E2EE_STATE_KEY);
    if (getActivePubkey() !== account || store.getState().identity.pubkey !== account) return;
    store.dispatch(hydrateSpaceE2ee({ account, spaces: sanitizeSpaceE2eeRecord(raw) }));
  })();
  const entry = { account, promise };
  loading = entry;
  promise.then(
    () => {
      if (loading === entry) loading = null;
    },
    () => {
      if (loading === entry) loading = null;
    },
  );
  return promise;
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
