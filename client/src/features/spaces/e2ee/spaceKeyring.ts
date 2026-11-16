// Runtime side of encrypted spaces for the active account (docs/E2EE_SPACES.md
// §5): epoch keys in memory (loaded from the keychain, or re-derived from grant
// events), the rules for accepting a grant, and issuing keys as a manager.
//
// Redux holds only the non-secret record (`spaceE2eeSlice`); the same record
// is persisted per account so a space stays marked encrypted across restarts
// even before its keys are back in memory.

import {
  SpaceE2eeError,
  buildSpaceKeyGrants,
  epochIdOf,
  generateEpochKey,
  judgeEpochGrant,
  openSpaceKeyGrant,
  openSpaceKeyGrantWithKey,
  pickSendEpoch,
  readGrantHeader,
  spaceIdCommitsTo,
  committedSpaceId,
  generateSpaceIdSalt,
  type GrantVerdict,
  type OpenedGrant,
} from "@ishtarservices/core";
import type { SpaceEpochInfo, SpaceHistoryPolicy } from "@ishtarservices/shared-types";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { store } from "@/store";
import {
  addEpochHolders,
  encryptedSpaceEntry,
  epochAccepted,
  forgetEncryptedSpace,
  markSpaceEncrypted,
  setReadyEpochs,
  type EncryptedSpaceState,
} from "@/store/slices/spaceE2eeSlice";
import { FEATURE_E2EE_SPACES } from "@/store/slices/featuresSlice";
import { nip44Decrypt } from "@/lib/nostr/nip44";
import { signWithAccount } from "@/lib/nostr/publish";
import { normalizeRelayUrl } from "@/lib/nostr/relayUrl";
import { relayManager } from "@/lib/nostr/relayManager";
import { forgetSeenEvents } from "@/lib/nostr/forgetSeen";
import type { NostrEvent } from "@/types/nostr";
import type { Space } from "@/types/space";
import { resolveRelaySet } from "../relaySet";
import { forgetSpaceKeys, loadSpaceKeys, saveSpaceKey } from "./spaceKeyStore";
import {
  ensureSpaceE2eeRecord,
  isSpaceE2eeRecordLoaded,
  persistSpaceE2eeRecord,
  resetSpaceE2eeRecord,
} from "./e2eeRecord";

export { SPACE_E2EE_STATE_KEY } from "./e2eeRecord";

/** spaceId -> epochId -> key. Session memory only. */
const keys = new Map<string, Map<string, Uint8Array>>();
/** Bumped on every session teardown so in-flight work can't land in the next
 *  account's state. */
let generation = 0;
let hydration: { pubkey: string; promise: Promise<void> } | null = null;
/** Grants addressed to this account whose unwrap failed because the signer was
 *  away. Retried by `retryPendingGrants`. */
const undecrypted = new Map<string, NostrEvent>();
/** spaceId -> grants that could not be accepted yet (they link to epochs that
 *  have not arrived, or their signer is not known as a manager yet). */
const deferred = new Map<string, Map<string, DeferredGrant>>();

type EpochListener = (spaceId: string, epochId: string) => void;
const epochListeners = new Set<EpochListener>();

/** Notified when this session gains an epoch key (to release parked events). */
export function onSpaceEpochReady(listener: EpochListener): () => void {
  epochListeners.add(listener);
  return () => epochListeners.delete(listener);
}

export function isSpaceE2eeEnabled(): boolean {
  return store.getState().features.enabled.includes(FEATURE_E2EE_SPACES);
}

function stateOf(spaceId: string): EncryptedSpaceState | undefined {
  return encryptedSpaceEntry(store.getState().spaceE2ee.spaces, spaceId);
}

export function isEncryptedSpace(spaceId: string): boolean {
  return stateOf(spaceId) !== undefined;
}

function myPubkey(): string | null {
  return store.getState().identity.pubkey;
}

function isActive(account: string, gen: number): boolean {
  return gen === generation && myPubkey() === account;
}

/**
 * Write the non-secret record for `account`. Call sites pass the account and
 * generation they started with: after an await the active account may have
 * changed, and writing then would store one account's record (or an empty
 * one) under another's name.
 */
function persist(account: string, gen: number): void {
  if (!isActive(account, gen)) return;
  persistSpaceE2eeRecord(account);
}

/** Drop every key from memory, and the previous account's record from the
 *  store; call on account switch and logout. */
export function clearSpaceE2eeSession(): void {
  generation++;
  for (const epochs of keys.values()) for (const key of epochs.values()) key.fill(0);
  keys.clear();
  undecrypted.clear();
  deferred.clear();
  pendingRotations.clear();
  hydration = null;
  resetSpaceE2eeRecord();
}

/**
 * Load the account's record into Redux, then its stored keys into memory.
 * Safe to call repeatedly; one load per account per session. Runs whether or
 * not the feature is on, because the "never send plaintext here" rule does
 * not depend on it.
 *
 * The record (which spaces are encrypted) is in the store BEFORE any keychain
 * read, so a slow keychain or an OS prompt can never open a window in which a
 * known encrypted space looks ordinary. Keys follow; events that arrive in
 * between wait in the parked queue and are released once their key is here.
 */
export function ensureSpaceE2eeHydrated(): Promise<void> {
  const account = myPubkey();
  if (!account) return Promise.resolve();
  if (hydration?.pubkey === account) return hydration.promise;

  const gen = generation;
  const promise = (async () => {
    await ensureSpaceE2eeRecord();
    if (!isActive(account, gen) || !isSpaceE2eeRecordLoaded()) return;
    const record = store.getState().spaceE2ee.spaces;
    const loaded = new Map<string, Map<string, Uint8Array>>();
    for (const spaceId of Object.keys(record)) {
      const stored = await loadSpaceKeys(account, spaceId).catch(() => ({}) as Record<string, string>);
      const recorded = new Set((stateOf(spaceId)?.epochs ?? []).map((e) => e.id));
      const epochs = new Map<string, Uint8Array>();
      for (const [epochId, hex] of Object.entries(stored)) {
        // Only epochs with a record are usable (the record carries seq and
        // managers); a key without one is left for its grant to re-establish.
        // A slot that doesn't match its own name is ignored, never trusted.
        if (!recorded.has(epochId)) continue;
        const key = hexToBytes(hex);
        if (epochIdOf(key) === epochId) epochs.set(epochId, key);
      }
      if (epochs.size > 0) loaded.set(spaceId, epochs);
    }
    if (!isActive(account, gen)) return;
    for (const [spaceId, epochs] of loaded) {
      // Keep anything accepted from a grant while the keychain was loading.
      const merged = keys.get(spaceId) ?? new Map<string, Uint8Array>();
      for (const [epochId, key] of epochs) if (!merged.has(epochId)) merged.set(epochId, key);
      keys.set(spaceId, merged);
      store.dispatch(setReadyEpochs({ spaceId, epochIds: [...merged.keys()] }));
    }
    // Anything parked while the keychain was loading can be opened now.
    for (const [spaceId, epochs] of loaded) {
      for (const epochId of epochs.keys()) for (const listener of epochListeners) listener(spaceId, epochId);
    }
  })();
  const entry = { pubkey: account, promise };
  hydration = entry;
  // A record that could not be read is tried again on the next call.
  promise.catch(() => {
    if (hydration === entry) hydration = null;
  });
  return promise;
}

export function getEpochKey(spaceId: string, epochId: string): Uint8Array | undefined {
  return keys.get(spaceId)?.get(epochId);
}

/** Epochs of a space this session can actually use (record + key in memory). */
export function usableEpochs(spaceId: string): SpaceEpochInfo[] {
  const held = keys.get(spaceId);
  if (!held) return [];
  return (stateOf(spaceId)?.epochs ?? []).filter((e) => held.has(e.id));
}

/** The epoch to seal with, and its key; null when none is held. */
export function sendEpochOf(spaceId: string): { info: SpaceEpochInfo; key: Uint8Array } | null {
  const info = pickSendEpoch(usableEpochs(spaceId));
  const key = info ? getEpochKey(spaceId, info.id) : undefined;
  return info && key ? { info, key } : null;
}

/** May `pubkey` issue keys for this space, by the chain this device holds? */
export function isSpaceKeyManager(spaceId: string, pubkey: string | null = myPubkey()): boolean {
  if (!pubkey) return false;
  const state = stateOf(spaceId);
  if (!state?.root) return false;
  if (state.root === pubkey) return true;
  const newest = pickSendEpoch(state.epochs);
  return !!newest && newest.managers.includes(pubkey);
}

function findSpace(spaceId: string): Space | undefined {
  return store.getState().spaces.list.find((s) => s.id === spaceId);
}

/**
 * Could `signer` be allowed to issue a key for this space at all? Decided from
 * the grant's public header alone, BEFORE the account signer is asked to
 * decrypt anything, so grant spam costs no signer round trips. The real
 * decision is `judgeEpochGrant` on the decrypted payload.
 *
 * The header's root has already been checked against the space id (the id
 * commits to its key root, docs/E2EE_SPACES.md §5.4), so nothing here comes
 * from the server:
 *  - first key: only the root the id commits to;
 *  - after that: the pinned root, or a manager of an accepted epoch.
 */
export function signerMayIssue(
  state: Pick<EncryptedSpaceState, "root" | "epochs"> | undefined,
  header: { root: string },
  signer: string,
): boolean {
  if (state?.root) {
    if (header.root !== state.root) return false;
    return signer === state.root || state.epochs.some((e) => e.managers.includes(signer));
  }
  return signer === header.root;
}

async function adoptEpoch(
  account: string,
  spaceId: string,
  anchor: { root: string; rootSalt: string },
  info: SpaceEpochInfo,
  key: Uint8Array,
  gen: number,
): Promise<boolean> {
  // Keychain first: a key that isn't stored must not look usable.
  await saveSpaceKey(account, spaceId, info.id, bytesToHex(key));
  if (!isActive(account, gen)) return false;
  let epochs = keys.get(spaceId);
  if (!epochs) {
    epochs = new Map();
    keys.set(spaceId, epochs);
  }
  epochs.set(info.id, key);
  store.dispatch(epochAccepted({ spaceId, root: anchor.root, rootSalt: anchor.rootSalt, epoch: info }));
  persist(account, gen);
  for (const listener of epochListeners) listener(spaceId, info.id);
  return true;
}

// Grants of a space are judged one at a time, in arrival order: whether one is
// acceptable depends on the epochs accepted before it.
const acceptChains = new Map<string, Promise<unknown>>();
function serializedFor<T>(spaceId: string, fn: () => Promise<T>): Promise<T> {
  const run = (acceptChains.get(spaceId) ?? Promise.resolve()).then(fn, fn);
  acceptChains.set(
    spaceId,
    run.catch(() => {}),
  );
  return run;
}

export type GrantOutcome =
  /** A new epoch key was stored. */
  | "accepted"
  /** An epoch already held (its holder list may have been updated). */
  | "known"
  /** Not addressed to this account. */
  | "not-recipient"
  /** The signer may not issue this (kept in case later epochs change that). */
  | "unauthorized"
  /** Linked to epochs that have not arrived yet; retried when they do. */
  | "deferred"
  /** Malformed, or the key / payload did not check out. Final. */
  | "invalid"
  /** The account signer could not be asked; retried later. */
  | "retry";

interface DeferredGrant {
  event: NostrEvent;
  /** Kept so a retry doesn't ask the signer to decrypt the same entry again. */
  opened?: OpenedGrant;
}

/** Kept grants per signer per space. Bounded per signer, so a member who
 *  floods a space with grants only ever evicts their own. */
const MAX_DEFERRED_PER_SIGNER = 8;
/** Distinct signers with kept grants per space; past this the grant is
 *  dropped and un-marked so a later delivery can bring it back. */
const MAX_DEFERRED_SIGNERS = 32;

function defer(spaceId: string, event: NostrEvent, opened?: OpenedGrant): void {
  let list = deferred.get(spaceId);
  if (!list) {
    list = new Map();
    deferred.set(spaceId, list);
  }
  const existing = list.get(event.id);
  if (existing) {
    existing.opened = opened ?? existing.opened;
    return;
  }
  const fromSigner = [...list.values()].filter((d) => d.event.pubkey === event.pubkey);
  const signers = new Set([...list.values()].map((d) => d.event.pubkey));
  if (!signers.has(event.pubkey) && signers.size >= MAX_DEFERRED_SIGNERS) {
    forgetSeenEvents([event.id]);
    return;
  }
  if (fromSigner.length >= MAX_DEFERRED_PER_SIGNER) {
    const oldest = fromSigner[0].event.id;
    list.delete(oldest);
    forgetSeenEvents([oldest]);
  }
  list.set(event.id, { event, opened });
}

async function processGrant(
  event: NostrEvent,
  account: string,
  gen: number,
  preOpened?: OpenedGrant,
): Promise<GrantOutcome> {
  const header = readGrantHeader(event);
  if (!header) return "invalid";
  const { spaceId, epochId } = header;
  const space = findSpace(spaceId);
  if (!space) return "unauthorized";
  const signer = event.pubkey;

  let state = stateOf(spaceId);
  if (state?.root && header.root !== state.root) return "unauthorized"; // another root: never
  if (!signerMayIssue(state, header, signer)) {
    // Not now. It may become acceptable once an epoch naming this signer a
    // manager arrives.
    defer(spaceId, event, preOpened);
    return "unauthorized";
  }

  const held = getEpochKey(spaceId, epochId);
  if (held) {
    // Nothing new to learn but who else holds this epoch, and only from a
    // grant that really is for it: the payload must open under the held key.
    try {
      openSpaceKeyGrantWithKey(event, held);
    } catch {
      return "invalid";
    }
    const info = state?.epochs.find((e) => e.id === epochId);
    if (state?.root && info && (signer === state.root || info.managers.includes(signer))) {
      store.dispatch(addEpochHolders({ spaceId, epochId, holders: header.recipients }));
      persist(account, gen);
    }
    return "known";
  }

  if (!header.recipients.includes(account)) {
    // The payload can't be read. A grant from someone who can issue keys is
    // still how a device learns the space is encrypted.
    if (!state) {
      store.dispatch(markSpaceEncrypted(spaceId));
      persist(account, gen);
    }
    return "not-recipient";
  }

  let opened = preOpened;
  if (!opened) {
    try {
      opened = await openSpaceKeyGrant(event, account, nip44Decrypt);
    } catch (err) {
      if (err instanceof SpaceE2eeError) return "invalid";
      // The signer was away (locked extension, remote signer timeout): that
      // says nothing about the grant. Keep it for a retry.
      undecrypted.set(event.id, event);
      return "retry";
    }
    if (!isActive(account, gen)) return "retry";
    undecrypted.delete(event.id);
  }
  const { payload } = opened;

  state = stateOf(spaceId);
  // The payload's root and salt equal the header's, which open the space id.
  const anchor = { root: payload.root, rootSalt: payload.rootSalt };
  let verdict: GrantVerdict;
  if (state?.root) {
    verdict = judgeEpochGrant(payload, signer, state.root, state.epochs);
  } else {
    // First key: only from the root the space id commits to. No creator or
    // admin list from a server is consulted.
    verdict = signer === payload.root ? "accept" : "reject";
  }
  if (verdict === "defer") {
    defer(spaceId, event, opened);
    return "deferred";
  }
  if (verdict === "reject") return "unauthorized";

  const info: SpaceEpochInfo = {
    id: payload.epoch,
    seq: payload.seq,
    prev: payload.prev,
    managers: payload.managers,
    history: payload.history,
    at: payload.at,
    grantedBy: signer,
  };
  if (!(await adoptEpoch(account, spaceId, anchor, info, opened.key, gen))) return "retry";
  store.dispatch(addEpochHolders({ spaceId, epochId, holders: header.recipients }));
  persist(account, gen);
  return "accepted";
}

/** Re-judge the grants kept for a space; repeats while that accepts anything. */
async function retryDeferred(spaceId: string, account: string, gen: number): Promise<void> {
  for (;;) {
    const list = deferred.get(spaceId);
    if (!list || list.size === 0) return;
    let progressed = false;
    for (const [id, entry] of [...list]) {
      list.delete(id);
      const outcome = await processGrant(entry.event, account, gen, entry.opened);
      if (outcome === "accepted") progressed = true;
    }
    if (!progressed) return;
  }
}

/**
 * A verified kind-4291 grant arrived. Returns false when it was not judged at
 * all (feature off, logged out, not one of this account's spaces), so the
 * pipeline lets a later copy through.
 */
export function handleKeyGrant(event: NostrEvent, onOutcome?: (outcome: GrantOutcome) => void): boolean {
  const account = myPubkey();
  if (!account || !isSpaceE2eeEnabled()) return false;
  const header = readGrantHeader(event);
  if (!header) {
    // Malformed, or its root doesn't open the space id (or the space isn't
    // an encrypted one): final.
    onOutcome?.("invalid");
    return true;
  }
  if (!findSpace(header.spaceId)) return false;

  const gen = generation;
  void ensureSpaceE2eeHydrated()
    .then(() =>
      serializedFor(header.spaceId, async () => {
        if (!isActive(account, gen)) return "retry" as const;
        const outcome = await processGrant(event, account, gen);
        // A newly accepted epoch can make waiting grants acceptable.
        if (outcome === "accepted") await retryDeferred(header.spaceId, account, gen);
        return outcome;
      }),
    )
    .then(onOutcome, () => onOutcome?.("retry"));
  return true;
}

/** Try again the grants that could not be judged: the signer was away, or the
 *  space's admin list had not loaded yet. */
export async function retryPendingGrants(): Promise<void> {
  const account = myPubkey();
  if (!account) return;
  const gen = generation;
  for (const event of [...undecrypted.values()]) {
    const header = readGrantHeader(event);
    undecrypted.delete(event.id);
    if (!header) continue;
    await serializedFor(header.spaceId, async () => {
      const outcome = await processGrant(event, account, gen);
      if (outcome === "accepted") await retryDeferred(header.spaceId, account, gen);
    });
  }
  for (const spaceId of [...deferred.keys()]) {
    await serializedFor(spaceId, () => retryDeferred(spaceId, account, gen));
  }
}

// ── Issuing keys ─────────────────────────────────────────────────────────────

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

/** Thrown when the space's relay did not take a grant: the recipients have no
 *  key, and the caller must not act as if they did. */
export class GrantNotStoredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantNotStoredError";
  }
}

/**
 * Sign the grants handing `key` to `recipients` and publish them, resolving
 * only once the space's host relay has stored every one. The relay is where
 * members (and their other devices) find their keys; a grant it refused or
 * never answered hands nobody anything, so that throws.
 */
async function publishGrants(
  space: Space,
  granter: string,
  root: string,
  key: Uint8Array,
  info: SpaceEpochInfo,
  recipients: string[],
): Promise<void> {
  const account = granter;
  const gen = generation;
  const targets = resolveRelaySet(space);
  for (const url of targets) relayManager.connect(url, "read+write");
  const host = normalizeRelayUrl(space.hostRelay);
  const rootSalt = stateOf(space.id)?.rootSalt;
  if (!rootSalt) throw new GrantNotStoredError("This space's key root isn't known on this device.");
  const grants = buildSpaceKeyGrants({
    granter,
    spaceId: space.id,
    rootSalt,
    epochKey: key,
    seq: info.seq,
    prev: info.prev,
    root,
    managers: info.managers,
    history: info.history,
    at: info.at,
    recipients,
  });
  for (const unsigned of grants) {
    const signed = await signWithAccount(unsigned);
    if (!isActive(account, gen)) throw new GrantNotStoredError("The account changed.");
    const results = await relayManager.publishWithConfirmation(signed, targets.length ? targets : undefined);
    const verdict = results.find((r) => normalizeRelayUrl(r.relayUrl) === host);
    if (!verdict?.success) {
      throw new GrantNotStoredError(
        verdict ? `The space's relay refused the key: ${verdict.message || "no reason given"}` : "The space's relay didn't answer.",
      );
    }
    if (!isActive(account, gen)) return;
    // For display only (who holds which key). Decisions about who still needs
    // a key are taken from what the relay serves (freshHolders.ts).
    const header = readGrantHeader(signed);
    if (header) {
      store.dispatch(addEpochHolders({ spaceId: space.id, epochId: header.epochId, holders: header.recipients }));
    }
  }
  persist(account, gen);
}

/**
 * Make a space encrypted, step 1 (local only): create epoch 0 and store it.
 * Called by the creator BEFORE the space is created anywhere, so a keychain
 * failure aborts the creation instead of leaving a space that was meant to be
 * encrypted open to plaintext. From here on this device treats the space id as
 * encrypted. Idempotent, so a retried creation reuses the epoch. If the
 * creation is abandoned, `abandonFirstEpoch` undoes it.
 *
 * The creator becomes the space's key root and, in this version, its only
 * key manager: the manager list is never filled from the server's role list
 * (docs/E2EE_SPACES.md §5.4).
 */
export async function prepareFirstEpoch(space: Space, history: SpaceHistoryPolicy, rootSalt: string): Promise<void> {
  const account = myPubkey();
  if (!account) throw new Error("Not logged in");
  // The id must commit to this account as the key root: that is what lets
  // every member check the root with no server input.
  if (!spaceIdCommitsTo(space.id, account, rootSalt)) {
    throw new Error("This space's id isn't an encrypted-space id for this account.");
  }
  await ensureSpaceE2eeHydrated();
  if (sendEpochOf(space.id)) return;
  const gen = generation;
  const key = generateEpochKey();
  const info: SpaceEpochInfo = {
    id: epochIdOf(key),
    seq: 0,
    prev: null,
    managers: [account],
    history,
    at: Math.floor(Date.now() / 1000),
    grantedBy: account,
  };
  if (!(await adoptEpoch(account, space.id, { root: account, rootSalt }, info, key, gen))) {
    throw new Error("The account changed while the space was being set up.");
  }
}

/** A fresh committed id for a new encrypted space whose key root is `root`
 *  (docs/E2EE_SPACES.md §5.4), and the salt that opens it. */
export function newEncryptedSpaceId(root: string): { id: string; rootSalt: string } {
  const rootSalt = generateSpaceIdSalt();
  return { id: committedSpaceId(root, rootSalt), rootSalt };
}

/**
 * Undo `prepareFirstEpoch` for a space that was never created (the creation
 * failed, was cancelled, or encryption was unticked). Only a space this device
 * prepared and nobody else has keys for is touched: one epoch, made here,
 * with no grant stored anywhere.
 */
export async function abandonFirstEpoch(spaceId: string): Promise<void> {
  const account = myPubkey();
  const state = stateOf(spaceId);
  if (!account || !state) return;
  const only = state.epochs.length === 1 ? state.epochs[0] : null;
  if (!only || only.seq !== 0 || only.grantedBy !== account || state.root !== account) return;
  if ((state.holders[only.id] ?? []).length > 0) return;
  await forgetSpaceE2ee(spaceId);
}

/**
 * Make a space encrypted, step 2: publish the first grant (to the creator, so
 * their other devices get the key, and to anyone already a member) once the
 * space exists on its relay. If it doesn't go out, the next key reconcile sees
 * nobody holding the key and publishes it then.
 */
export async function publishFirstEpoch(space: Space): Promise<void> {
  const account = myPubkey();
  const current = sendEpochOf(space.id);
  const root = stateOf(space.id)?.root;
  if (!account || !current || !root) throw new Error("This space's key isn't on this device.");
  await publishGrants(space, account, root, current.key, current.info, uniq([account, ...space.memberPubkeys]));
}

/** A rotation whose grants did not all reach the relay: its key is kept (and
 *  in the keychain) and the next reconcile publishes it again before anything
 *  else. Until then this device keeps sealing under the previous epoch, which
 *  everyone still in the space holds; the removed member is already refused
 *  by the relay. */
interface PendingRotation {
  key: Uint8Array;
  info: SpaceEpochInfo;
  root: string;
  recipients: string[];
}
const pendingRotations = new Map<string, PendingRotation>();

/** Is a rotation waiting for its grants to reach the relay? */
export function hasPendingRotation(spaceId: string): boolean {
  return pendingRotations.has(spaceId);
}

async function completeRotation(spaceId: string, pending: PendingRotation): Promise<void> {
  const account = myPubkey();
  const space = findSpace(spaceId);
  if (!account || !space) throw new Error("This space isn't on this device.");
  const gen = generation;
  await publishGrants(space, account, pending.root, pending.key, pending.info, pending.recipients);
  if (!isActive(account, gen)) return;
  pendingRotations.delete(spaceId);
  // Only now does the new epoch become the one this device seals with.
  const rootSalt = stateOf(spaceId)?.rootSalt;
  if (!rootSalt) throw new Error("This space's key root isn't known on this device.");
  await adoptEpoch(account, spaceId, { root: pending.root, rootSalt }, pending.info, pending.key, gen);
}

/**
 * Start a new epoch and hand it to `recipients` (everyone still in the space).
 * The previous epoch's holders who are not recipients are cut off from here on.
 * The new epoch is used for sending only once the relay has stored its
 * grants; a rotation that could not be published is retried (`hasPendingRotation`).
 */
export async function rotateSpaceKey(spaceId: string, recipients: string[]): Promise<void> {
  const account = myPubkey();
  const space = findSpace(spaceId);
  const current = sendEpochOf(spaceId);
  const root = stateOf(spaceId)?.root;
  if (!account || !space || !current || !root) throw new Error("This space's key isn't on this device.");
  if (!isSpaceKeyManager(spaceId, account)) throw new Error("Only the space's key manager can change the key.");
  const to = uniq([account, ...recipients]);

  const waiting = pendingRotations.get(spaceId);
  if (waiting && waiting.info.prev === current.info.id) {
    // Retry the same rotation for the current roster (one fewer if someone
    // else left meanwhile; a newcomer is granted once it is in place).
    waiting.recipients = waiting.recipients.filter((pk) => to.includes(pk));
    await completeRotation(spaceId, waiting);
    return;
  }

  const key = generateEpochKey();
  const info: SpaceEpochInfo = {
    id: epochIdOf(key),
    seq: current.info.seq + 1,
    prev: current.info.id,
    // Carried forward from the chain, never taken from the server's roles.
    managers: uniq([root, ...current.info.managers.filter((pk) => to.includes(pk))]),
    history: current.info.history,
    at: Math.floor(Date.now() / 1000),
    grantedBy: account,
  };
  // In the keychain before anything goes out: a grant the relay stores must
  // never name a key this device could lose.
  await saveSpaceKey(account, spaceId, info.id, bytesToHex(key));
  const pending: PendingRotation = { key, info, root, recipients: to };
  pendingRotations.set(spaceId, pending);
  await completeRotation(spaceId, pending);
}

/** Retry a rotation whose grants did not reach the relay. False if none waits. */
export async function retryPendingRotation(spaceId: string): Promise<boolean> {
  const pending = pendingRotations.get(spaceId);
  if (!pending) return false;
  await completeRotation(spaceId, pending);
  return true;
}

/** Hand `epochs` (held by this device) to `recipients` as late grants. */
export async function grantEpochs(spaceId: string, epochs: SpaceEpochInfo[], recipients: string[]): Promise<void> {
  const account = myPubkey();
  const space = findSpace(spaceId);
  const root = stateOf(spaceId)?.root;
  if (!account || !space || !root) throw new Error("This space's key isn't on this device.");
  if (!isSpaceKeyManager(spaceId, account)) throw new Error("Only the space's key manager can share the key.");
  for (const info of epochs) {
    const key = getEpochKey(spaceId, info.id);
    if (!key) continue;
    await publishGrants(space, account, root, key, info, recipients);
  }
}

/** The pinned key root of a space, for the epoch-holder lookup. */
export function keyRootOf(spaceId: string): string | null {
  return stateOf(spaceId)?.root ?? null;
}

/** Forget a space's keys and its encrypted marker on this device. Waits for
 *  the account's record, so it never writes a record that isn't loaded. */
export async function forgetSpaceE2ee(spaceId: string): Promise<void> {
  const account = myPubkey();
  if (!account) return;
  const gen = generation;
  await ensureSpaceE2eeRecord();
  if (!isActive(account, gen) || !isSpaceE2eeRecordLoaded()) return;
  const held = keys.get(spaceId);
  if (held) for (const key of held.values()) key.fill(0);
  keys.delete(spaceId);
  pendingRotations.delete(spaceId);
  store.dispatch(forgetEncryptedSpace(spaceId));
  persist(account, gen);
  await forgetSpaceKeys(account, spaceId).catch(() => {});
}
