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
  /** True once the account's persisted record was loaded this session. */
  hydrated: boolean;
  spaces: Record<string, EncryptedSpaceState>;
  /** spaceId -> epoch ids whose key is in this session's memory. */
  ready: Record<string, string[]>;
}

const initialState: SpaceE2eeState = { hydrated: false, spaces: {}, ready: {} };

function ensure(state: SpaceE2eeState, spaceId: string): EncryptedSpaceState {
  let entry = state.spaces[spaceId];
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
    /** Replace the persisted part at login. */
    hydrateSpaceE2ee(state, action: PayloadAction<Record<string, EncryptedSpaceState>>) {
      state.spaces = action.payload;
      state.ready = {};
      state.hydrated = true;
    },
    /** Remember that a space is encrypted (sticky). */
    markSpaceEncrypted(state, action: PayloadAction<string>) {
      ensure(state, action.payload);
    },
    /** An authorized grant named these key holders for an epoch. */
    addEpochHolders(state, action: PayloadAction<{ spaceId: string; epochId: string; holders: string[] }>) {
      const entry = ensure(state, action.payload.spaceId);
      const current = entry.holders[action.payload.epochId] ?? [];
      const merged = [...current];
      for (const pk of action.payload.holders) if (!merged.includes(pk)) merged.push(pk);
      if (merged.length !== current.length) entry.holders[action.payload.epochId] = merged;
    },
    /** This account accepted a key for an epoch. */
    epochAccepted(state, action: PayloadAction<{ spaceId: string; root: string; epoch: SpaceEpochInfo }>) {
      const entry = ensure(state, action.payload.spaceId);
      if (!entry.root) entry.root = action.payload.root;
      if (!entry.epochs.some((e) => e.id === action.payload.epoch.id)) entry.epochs.push(action.payload.epoch);
      const ready = state.ready[action.payload.spaceId] ?? [];
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
  markSpaceEncrypted,
  addEpochHolders,
  epochAccepted,
  setReadyEpochs,
  forgetEncryptedSpace,
} = spaceE2eeSlice.actions;

/** Is this space end-to-end encrypted (as far as this device knows)? */
export const selectIsEncryptedSpace =
  (spaceId: string | null | undefined) =>
  (state: RootState): boolean =>
    !!spaceId && state.spaceE2ee.spaces[spaceId] !== undefined;

/** Does this session hold a key to send with in this space? */
export const selectHasSpaceKey =
  (spaceId: string | null | undefined) =>
  (state: RootState): boolean =>
    !!spaceId && (state.spaceE2ee.ready[spaceId]?.length ?? 0) > 0;
