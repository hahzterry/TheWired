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
  hydrateSpaceE2ee,
  markSpaceEncrypted,
  setReadyEpochs,
  type EncryptedSpaceState,
} from "@/store/slices/spaceE2eeSlice";
import { FEATURE_E2EE_SPACES } from "@/store/slices/featuresSlice";
import { getUserState, saveUserState } from "@/lib/db/userStateStore";
import { nip44Decrypt } from "@/lib/nostr/nip44";
import { signAndPublish } from "@/lib/nostr/publish";
import { relayManager } from "@/lib/nostr/relayManager";
import type { NostrEvent } from "@/types/nostr";
import type { Space } from "@/types/space";
import { resolveRelaySet } from "../relaySet";
import { forgetSpaceKeys, loadSpaceKeys, saveSpaceKey } from "./spaceKeyStore";

/** userStateStore key of the non-secret record. */
export const SPACE_E2EE_STATE_KEY = "e2ee_spaces";

const HEX64_RE = /^[0-9a-f]{64}$/;

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
  saveUserState(SPACE_E2EE_STATE_KEY, store.getState().spaceE2ee.spaces).catch(() => {});
}

/** Drop every key from memory; call on account switch and logout. */
export function clearSpaceE2eeSession(): void {
  generation++;
  for (const epochs of keys.values()) for (const key of epochs.values()) key.fill(0);
  keys.clear();
  undecrypted.clear();
  deferred.clear();
  hydration = null;
}

function sanitizeRecord(raw: unknown): Record<string, EncryptedSpaceState> {
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

/**
 * Load the account's record into Redux and its stored keys into memory. Safe
 * to call repeatedly; one load per account per session. Runs whether or not
 * the feature is on, because the "never send plaintext here" rule does not
 * depend on it.
 */
export function ensureSpaceE2eeHydrated(): Promise<void> {
  const account = myPubkey();
  if (!account) return Promise.resolve();
  if (hydration?.pubkey === account) return hydration.promise;

  const gen = generation;
  const promise = (async () => {
    const record = sanitizeRecord(await getUserState(SPACE_E2EE_STATE_KEY).catch(() => null));
    // Keys first, state second: once Redux says "hydrated" the controller
    // opens subscriptions, and events must find their keys already here.
    const loaded = new Map<string, Map<string, Uint8Array>>();
    for (const spaceId of Object.keys(record)) {
      const stored = await loadSpaceKeys(account, spaceId).catch(() => ({}) as Record<string, string>);
      const recorded = new Set(record[spaceId].epochs.map((e) => e.id));
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
    for (const [spaceId, epochs] of loaded) keys.set(spaceId, epochs);
    store.dispatch(hydrateSpaceE2ee(record));
    for (const [spaceId, epochs] of loaded) {
      store.dispatch(setReadyEpochs({ spaceId, epochIds: [...epochs.keys()] }));
    }
    // Anything parked while the keychain was loading can be opened now.
    for (const [spaceId, epochs] of loaded) {
      for (const epochId of epochs.keys()) for (const listener of epochListeners) listener(spaceId, epochId);
    }
  })();
  hydration = { pubkey: account, promise };
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
 * decrypt anything, so a member spamming grants costs no signer round trips.
 * The real decision is `judgeEpochGrant` on the decrypted payload.
 *  - With a pinned root: the root, or a manager of any accepted epoch.
 *  - First key (trust on first use): the space's creator or one of its admins
 *    as this device currently knows them.
 */
export function signerMayIssue(
  state: Pick<EncryptedSpaceState, "root" | "epochs"> | undefined,
  space: Pick<Space, "creatorPubkey" | "adminPubkeys">,
  signer: string,
): boolean {
  if (state?.root) return signer === state.root || state.epochs.some((e) => e.managers.includes(signer));
  return (space.creatorPubkey !== "" && signer === space.creatorPubkey) || space.adminPubkeys.includes(signer);
}

async function adoptEpoch(
  account: string,
  spaceId: string,
  root: string,
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
  store.dispatch(epochAccepted({ spaceId, root, epoch: info }));
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

const MAX_DEFERRED_PER_SPACE = 32;

function defer(spaceId: string, event: NostrEvent, opened?: OpenedGrant): void {
  let list = deferred.get(spaceId);
  if (!list) {
    list = new Map();
    deferred.set(spaceId, list);
  }
  if (!list.has(event.id) && list.size >= MAX_DEFERRED_PER_SPACE) {
    const oldest = list.keys().next().value;
    if (oldest !== undefined) list.delete(oldest);
  }
  list.set(event.id, { event, opened: opened ?? list.get(event.id)?.opened });
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
  if (!signerMayIssue(state, space, signer)) {
    // Not now. It may become acceptable once an epoch naming this signer a
    // manager arrives, or once the space's admin list has loaded.
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
  let root: string;
  let verdict: GrantVerdict;
  if (state?.root) {
    root = state.root;
    verdict = judgeEpochGrant(payload, signer, root, state.epochs);
  } else {
    // First key: pin the root the payload names. The signer was vouched for by
    // the space's creator/admin list; the payload must vouch for the signer too.
    root = payload.root;
    verdict = signer === payload.root || payload.managers.includes(signer) ? "accept" : "reject";
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
  if (!(await adoptEpoch(account, spaceId, root, info, opened.key, gen))) return "retry";
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
  if (!header) return true; // malformed: final
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
  const grants = buildSpaceKeyGrants({
    granter,
    spaceId: space.id,
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
    const signed = await signAndPublish(unsigned, targets.length ? targets : undefined);
    if (!isActive(account, gen)) return;
    // Only once the grant is signed and handed to the relay layer: recording a
    // holder before that would leave them without a key and never retried.
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
 * encrypted. Idempotent, so a retried creation reuses the epoch.
 *
 * The creator becomes the space's key root and, in this version, its only
 * key manager: the manager list is never filled from the server's role list
 * (docs/E2EE_SPACES.md §5.4).
 */
export async function prepareFirstEpoch(space: Space, history: SpaceHistoryPolicy): Promise<void> {
  const account = myPubkey();
  if (!account) throw new Error("Not logged in");
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
  if (!(await adoptEpoch(account, space.id, account, info, key, gen))) {
    throw new Error("The account changed while the space was being set up.");
  }
}

/**
 * Make a space encrypted, step 2: publish the first grant (to the creator, so
 * their other devices get the key, and to anyone already a member) once the
 * space exists on its relay. If this never goes out, the creator is not
 * recorded as a holder and the next reconcile publishes it.
 */
export async function publishFirstEpoch(space: Space): Promise<void> {
  const account = myPubkey();
  const current = sendEpochOf(space.id);
  const root = stateOf(space.id)?.root;
  if (!account || !current || !root) throw new Error("This space's key isn't on this device.");
  await publishGrants(space, account, root, current.key, current.info, uniq([account, ...space.memberPubkeys]));
}

/**
 * Start a new epoch and hand it to `recipients` (everyone still in the space).
 * The previous epoch's holders who are not recipients are cut off from here on.
 */
export async function rotateSpaceKey(spaceId: string, recipients: string[]): Promise<void> {
  const account = myPubkey();
  const space = findSpace(spaceId);
  const current = sendEpochOf(spaceId);
  const root = stateOf(spaceId)?.root;
  if (!account || !space || !current || !root) throw new Error("This space's key isn't on this device.");
  if (!isSpaceKeyManager(spaceId, account)) throw new Error("Only the space's key manager can change the key.");
  const gen = generation;
  const to = uniq([account, ...recipients]);
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
  if (!(await adoptEpoch(account, spaceId, root, info, key, gen))) return;
  await publishGrants(space, account, root, key, info, to);
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

/** Forget a space's keys and its encrypted marker on this device. */
export async function forgetSpaceE2ee(spaceId: string): Promise<void> {
  const account = myPubkey();
  const held = keys.get(spaceId);
  if (held) for (const key of held.values()) key.fill(0);
  keys.delete(spaceId);
  store.dispatch(forgetEncryptedSpace(spaceId));
  if (account) {
    persist(account, generation);
    await forgetSpaceKeys(account, spaceId).catch(() => {});
  }
}
