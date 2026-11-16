import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { SpaceEpochInfo } from "@ishtarservices/shared-types";
import type { RootState } from "../index";

/**
 * Non-secret state of end-to-end encrypted spaces (docs/E2EE_SPACES.md): which
 * spaces are encrypted, which epochs this account has accepted, and who was
 * handed each epoch's key. Epoch KEYS never come here — they live in the
 * keychain (`secretStore`) and in the keyring's memory.
 *
 * A space listed here is encrypted for good on this device: the client never
 * sends plaintext chat there and ignores plaintext chat it receives, whether
 * or not the feature is switched on.
 */
export interface EncryptedSpaceState {
  /** Who may always issue keys: the space's creator as known when the first
   *  grant was accepted. Null while only other members' grants have been seen. */
  root: string | null;
  /** Epochs this account accepted a key for. */
  epochs: SpaceEpochInfo[];
  /** epochId -> pubkeys an authorized grant handed that epoch's key to. */
  holders: Record<string, string[]>;
}

interface SpaceE2eeState {
  /**
   * The account whose record `spaces` is, or null while none is loaded. The
   * record counts as loaded only when this equals the logged-in pubkey: after
   * a logout or an account switch the previous account's record must not be
   * mistaken for the next one's (see `selectSpaceE2eeLoaded`).
   */
  account: string | null;
  spaces: Record<string, EncryptedSpaceState>;
  /** spaceId -> epoch ids whose key is in this session's memory. */
  ready: Record<string, string[]>;
}

const initialState: SpaceE2eeState = { account: null, spaces: {}, ready: {} };

const own = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

function ensure(state: SpaceE2eeState, spaceId: string): EncryptedSpaceState {
  let entry = own(state.spaces, spaceId) ? state.spaces[spaceId] : undefined;
  if (!entry) {
    entry = { root: null, epochs: [], holders: {} };
    state.spaces[spaceId] = entry;
  }
  return entry;
}

export const spaceE2eeSlice = createSlice({
  name: "spaceE2ee",
  initialState,
  reducers: {
    /** The account's persisted record was read (before any key is loaded). */
    hydrateSpaceE2ee(
      state,
      action: PayloadAction<{ account: string; spaces: Record<string, EncryptedSpaceState> }>,
    ) {
      state.account = action.payload.account;
      state.spaces = action.payload.spaces;
      state.ready = {};
    },
    /** Logout or account switch: nothing of the previous account stays. */
    resetSpaceE2ee() {
      return initialState;
    },
    /** Remember that a space is encrypted (sticky). */
    markSpaceEncrypted(state, action: PayloadAction<string>) {
      ensure(state, action.payload);
    },
    /** An authorized grant named these key holders for an epoch. */
    addEpochHolders(state, action: PayloadAction<{ spaceId: string; epochId: string; holders: string[] }>) {
      const entry = ensure(state, action.payload.spaceId);
      const current = own(entry.holders, action.payload.epochId) ? entry.holders[action.payload.epochId] : [];
      const merged = [...current];
      for (const pk of action.payload.holders) if (!merged.includes(pk)) merged.push(pk);
      if (merged.length !== current.length) entry.holders[action.payload.epochId] = merged;
    },
    /** This account accepted a key for an epoch. */
    epochAccepted(state, action: PayloadAction<{ spaceId: string; root: string; epoch: SpaceEpochInfo }>) {
      const entry = ensure(state, action.payload.spaceId);
      if (!entry.root) entry.root = action.payload.root;
      if (!entry.epochs.some((e) => e.id === action.payload.epoch.id)) entry.epochs.push(action.payload.epoch);
      const ready = own(state.ready, action.payload.spaceId) ? state.ready[action.payload.spaceId] : [];
      if (!ready.includes(action.payload.epoch.id)) state.ready[action.payload.spaceId] = [...ready, action.payload.epoch.id];
    },
    /** Epoch keys were loaded from the keychain into memory. */
    setReadyEpochs(state, action: PayloadAction<{ spaceId: string; epochIds: string[] }>) {
      state.ready[action.payload.spaceId] = action.payload.epochIds;
    },
    /** The space is gone from this account (left, removed, deleted). */
    forgetEncryptedSpace(state, action: PayloadAction<string>) {
      delete state.spaces[action.payload];
      delete state.ready[action.payload];
    },
  },
});

export const {
  hydrateSpaceE2ee,
  resetSpaceE2ee,
  markSpaceEncrypted,
  addEpochHolders,
  epochAccepted,
  setReadyEpochs,
  forgetEncryptedSpace,
} = spaceE2eeSlice.actions;

/**
 * The entry for a space id, or undefined. Always an OWN-property lookup: space
 * ids come from other people (a NIP-29 group can be named `constructor`), and
 * a plain `spaces[id]` would find `Object.prototype` members and treat such a
 * space as encrypted.
 */
export function encryptedSpaceEntry(
  spaces: Record<string, EncryptedSpaceState>,
  spaceId: string | null | undefined,
): EncryptedSpaceState | undefined {
  return spaceId && Object.prototype.hasOwnProperty.call(spaces, spaceId) ? spaces[spaceId] : undefined;
}

/**
 * Has the logged-in account's record of encrypted spaces been loaded? Until it
 * has, nobody can say a space is NOT encrypted, so the composer stays disabled
 * and nothing with a space's `h` tag is signed in the clear.
 */
export function isSpaceE2eeLoadedFor(state: Pick<RootState, "spaceE2ee" | "identity">): boolean {
  return state.spaceE2ee.account !== null && state.spaceE2ee.account === state.identity.pubkey;
}

export const selectSpaceE2eeLoaded = (state: RootState): boolean => isSpaceE2eeLoadedFor(state);

/** The pinned key root of an encrypted space, or null. */
export const selectSpaceKeyRoot =
  (spaceId: string | null | undefined) =>
  (state: RootState): string | null =>
    encryptedSpaceEntry(state.spaceE2ee.spaces, spaceId)?.root ?? null;

/** Is this space end-to-end encrypted (as far as this device knows)? */
export const selectIsEncryptedSpace =
  (spaceId: string | null | undefined) =>
  (state: RootState): boolean =>
    encryptedSpaceEntry(state.spaceE2ee.spaces, spaceId) !== undefined;

/** Does this session hold a key to send with in this space? */
export const selectHasSpaceKey =
  (spaceId: string | null | undefined) =>
  (state: RootState): boolean =>
    !!spaceId &&
    Object.prototype.hasOwnProperty.call(state.spaceE2ee.ready, spaceId) &&
    state.spaceE2ee.ready[spaceId].length > 0;
