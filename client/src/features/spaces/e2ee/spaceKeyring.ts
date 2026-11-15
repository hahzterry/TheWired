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
  openSpaceKeyGrant,
  pickSendEpoch,
  readGrantHeader,
} from "@ishtarservices/core";
import type { SpaceEpochInfo, SpaceHistoryPolicy } from "@ishtarservices/shared-types";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { store } from "@/store";
import {
  addEpochHolders,
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

export function isEncryptedSpace(spaceId: string): boolean {
  return store.getState().spaceE2ee.spaces[spaceId] !== undefined;
}

function myPubkey(): string | null {
  return store.getState().identity.pubkey;
}

function isActive(account: string, gen: number): boolean {
  return gen === generation && myPubkey() === account;
}

function persist(): void {
  saveUserState(SPACE_E2EE_STATE_KEY, store.getState().spaceE2ee.spaces).catch(() => {});
}

/** Drop every key from memory; call on account switch and logout. */
export function clearSpaceE2eeSession(): void {
  generation++;
  for (const epochs of keys.values()) for (const key of epochs.values()) key.fill(0);
  keys.clear();
  undecrypted.clear();
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
    out[spaceId] = { root: typeof v.root === "string" ? v.root : null, epochs, holders };
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
    if (!isActive(account, gen)) return;
    store.dispatch(hydrateSpaceE2ee(record));
    for (const spaceId of Object.keys(record)) {
      const stored = await loadSpaceKeys(account, spaceId).catch(() => ({}) as Record<string, string>);
      if (!isActive(account, gen)) return;
      const epochs = new Map<string, Uint8Array>();
      for (const [epochId, hex] of Object.entries(stored)) {
        const key = hexToBytes(hex);
        // A slot that doesn't match its own name is ignored, never trusted.
        if (epochIdOf(key) === epochId) epochs.set(epochId, key);
      }
      // Only epochs with a record are usable: the record carries seq/managers.
      const known = record[spaceId].epochs.map((e) => e.id).filter((id) => epochs.has(id));
      if (epochs.size > 0) keys.set(spaceId, epochs);
      store.dispatch(setReadyEpochs({ spaceId, epochIds: known }));
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
  return (store.getState().spaceE2ee.spaces[spaceId]?.epochs ?? []).filter((e) => held.has(e.id));
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
  const state = store.getState().spaceE2ee.spaces[spaceId];
  if (!state?.root) return false;
  if (state.root === pubkey) return true;
  const newest = pickSendEpoch(state.epochs);
  return !!newest && newest.managers.includes(pubkey);
}

function findSpace(spaceId: string): Space | undefined {
  return store.getState().spaces.list.find((s) => s.id === spaceId);
}

/**
 * Is `signer` allowed to issue a key for this space (docs/E2EE_SPACES.md §5.4)?
 *  - With a pinned root: the root, or a manager named by the newest accepted
 *    epoch. The server's role list plays no part.
 *  - First key (trust on first use): the space's creator, or one of its admins
 *    as this device currently knows them.
 */
export function grantSignerAuthorized(
  state: Pick<EncryptedSpaceState, "root" | "epochs"> | undefined,
  space: Pick<Space, "creatorPubkey" | "adminPubkeys">,
  signer: string,
): boolean {
  if (state?.root) {
    if (signer === state.root) return true;
    const newest = pickSendEpoch(state.epochs);
    return !!newest && newest.managers.includes(signer);
  }
  return signer === space.creatorPubkey || space.adminPubkeys.includes(signer);
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
  persist();
  for (const listener of epochListeners) listener(spaceId, info.id);
  return true;
}

// One unwrap at a time per space: several grants for the same epoch (chunks,
// late grants) must not each cost a signer round trip.
const acceptChains = new Map<string, Promise<unknown>>();
function serializedFor<T>(spaceId: string, fn: () => Promise<T>): Promise<T> {
  const run = (acceptChains.get(spaceId) ?? Promise.resolve()).then(fn, fn);
  acceptChains.set(
    spaceId,
    run.catch(() => {}),
  );
  return run;
}

export type GrantOutcome = "accepted" | "known" | "not-recipient" | "unauthorized" | "invalid" | "retry";

async function acceptGrant(event: NostrEvent, account: string, gen: number): Promise<GrantOutcome> {
  const header = readGrantHeader(event);
  if (!header) return "invalid";
  if (!header.recipients.includes(account)) return "not-recipient";
  if (getEpochKey(header.spaceId, header.epochId)) return "known";

  const space = findSpace(header.spaceId);
  if (!space) return "unauthorized";
  const state = store.getState().spaceE2ee.spaces[header.spaceId];
  if (!grantSignerAuthorized(state, space, event.pubkey)) return "unauthorized";

  let opened;
  try {
    opened = await openSpaceKeyGrant(event, account, nip44Decrypt);
  } catch (err) {
    if (err instanceof SpaceE2eeError) return "invalid";
    // The signer was away (locked extension, remote signer timeout): that says
    // nothing about the grant. Keep it for a retry.
    undecrypted.set(event.id, event);
    return "retry";
  }
  if (!isActive(account, gen)) return "retry";

  // The payload must itself vouch for whoever signed it, so an admin the
  // server listed can't hand out an epoch that doesn't name them.
  const root = state?.root ?? space.creatorPubkey;
  if (event.pubkey !== root && !opened.payload.managers.includes(event.pubkey)) return "unauthorized";

  const info: SpaceEpochInfo = {
    id: opened.payload.epoch,
    seq: opened.payload.seq,
    prev: opened.payload.prev,
    managers: opened.payload.managers,
    history: opened.payload.history,
    at: opened.payload.at,
    grantedBy: event.pubkey,
  };
  await adoptEpoch(account, header.spaceId, root, info, opened.key, gen);
  undecrypted.delete(event.id);
  return "accepted";
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
  void ensureSpaceE2eeHydrated().then(async () => {
    if (!isActive(account, gen)) return;
    const space = findSpace(header.spaceId);
    if (!space) return;
    const state = store.getState().spaceE2ee.spaces[header.spaceId];
    if (!grantSignerAuthorized(state, space, event.pubkey)) {
      onOutcome?.("unauthorized");
      return;
    }
    // An authorized grant is how a device learns a space is encrypted, and who
    // holds each epoch's key, whether or not this account is a recipient.
    const wasEncrypted = state !== undefined;
    store.dispatch(markSpaceEncrypted(header.spaceId));
    store.dispatch(
      addEpochHolders({ spaceId: header.spaceId, epochId: header.epochId, holders: header.recipients }),
    );
    if (!wasEncrypted) persist();

    const outcome = await serializedFor(header.spaceId, () => acceptGrant(event, account, gen));
    if (outcome !== "accepted") persist();
    onOutcome?.(outcome);
  });
  return true;
}

/** Try again the grants a missing signer left unopened. */
export async function retryPendingGrants(): Promise<void> {
  const account = myPubkey();
  if (!account || undecrypted.size === 0) return;
  const gen = generation;
  for (const event of [...undecrypted.values()]) {
    const header = readGrantHeader(event);
    if (!header) {
      undecrypted.delete(event.id);
      continue;
    }
    const outcome = await serializedFor(header.spaceId, () => acceptGrant(event, account, gen));
    if (outcome !== "retry") undecrypted.delete(event.id);
  }
}

// ── Issuing keys (managers) ──────────────────────────────────────────────────

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

async function publishGrants(
  space: Space,
  granter: string,
  key: Uint8Array,
  info: SpaceEpochInfo,
  recipients: string[],
): Promise<void> {
  const targets = resolveRelaySet(space);
  for (const url of targets) relayManager.connect(url, "read+write");
  const grants = buildSpaceKeyGrants({
    granter,
    spaceId: space.id,
    epochKey: key,
    seq: info.seq,
    prev: info.prev,
    managers: info.managers,
    history: info.history,
    at: info.at,
    recipients,
  });
  for (const unsigned of grants) {
    await signAndPublish(unsigned, targets.length ? targets : undefined);
  }
}

/** The managers an epoch issued now names: the root, the issuer, and the
 *  space's admins that are among the recipients. */
function managersFor(space: Space, root: string, issuer: string, recipients: string[]): string[] {
  return uniq([root, issuer, ...space.adminPubkeys.filter((pk) => recipients.includes(pk))]);
}

/**
 * Make a space encrypted, step 1 (local only): create epoch 0 and store it.
 * Called by the creator BEFORE the space is created anywhere, so a keychain
 * failure aborts the creation instead of leaving a space that was meant to be
 * encrypted open to plaintext. From here on this device treats the space id as
 * encrypted. Idempotent, so a retried creation reuses the epoch.
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
    managers: managersFor(space, account, account, uniq([account, ...space.memberPubkeys])),
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
 * space exists on its relay.
 */
export async function publishFirstEpoch(space: Space): Promise<void> {
  const account = myPubkey();
  const current = sendEpochOf(space.id);
  if (!account || !current) throw new Error("This space's key isn't on this device.");
  const recipients = uniq([account, ...space.memberPubkeys]);
  store.dispatch(addEpochHolders({ spaceId: space.id, epochId: current.info.id, holders: recipients }));
  persist();
  await publishGrants(space, account, current.key, current.info, recipients);
}

/**
 * Start a new epoch and hand it to `recipients` (everyone still in the space).
 * The previous epoch's holders who are not recipients are cut off from here on.
 */
export async function rotateSpaceKey(spaceId: string, recipients: string[]): Promise<void> {
  const account = myPubkey();
  const space = findSpace(spaceId);
  const current = sendEpochOf(spaceId);
  const root = store.getState().spaceE2ee.spaces[spaceId]?.root;
  if (!account || !space || !current || !root) throw new Error("This space's key isn't on this device.");
  if (!isSpaceKeyManager(spaceId, account)) throw new Error("Only a space admin can change the key.");
  const gen = generation;
  const to = uniq([account, ...recipients]);
  const key = generateEpochKey();
  const info: SpaceEpochInfo = {
    id: epochIdOf(key),
    seq: current.info.seq + 1,
    prev: current.info.id,
    managers: managersFor(space, root, account, to),
    history: current.info.history,
    at: Math.floor(Date.now() / 1000),
    grantedBy: account,
  };
  if (!(await adoptEpoch(account, spaceId, root, info, key, gen))) return;
  store.dispatch(addEpochHolders({ spaceId, epochId: info.id, holders: to }));
  persist();
  await publishGrants(space, account, key, info, to);
}

/** Hand `epochs` (held by this device) to `recipients` as late grants. */
export async function grantEpochs(spaceId: string, epochs: SpaceEpochInfo[], recipients: string[]): Promise<void> {
  const account = myPubkey();
  const space = findSpace(spaceId);
  if (!account || !space) throw new Error("This space's key isn't on this device.");
  if (!isSpaceKeyManager(spaceId, account)) throw new Error("Only a space admin can share the key.");
  for (const info of epochs) {
    const key = getEpochKey(spaceId, info.id);
    if (!key) continue;
    store.dispatch(addEpochHolders({ spaceId, epochId: info.id, holders: recipients }));
    await publishGrants(space, account, key, info, recipients);
  }
  persist();
}

/** Forget a space's keys and its encrypted marker on this device. */
export async function forgetSpaceE2ee(spaceId: string): Promise<void> {
  const account = myPubkey();
  const held = keys.get(spaceId);
  if (held) for (const key of held.values()) key.fill(0);
  keys.delete(spaceId);
  store.dispatch(forgetEncryptedSpace(spaceId));
  persist();
  if (account) await forgetSpaceKeys(account, spaceId).catch(() => {});
}
