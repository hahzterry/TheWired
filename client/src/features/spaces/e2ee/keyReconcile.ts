// Keeping an encrypted space's key in step with its roster
// (docs/E2EE_SPACES.md §5.2–5.3). Run by a manager's client:
//  - a roster member without the current key gets a late grant;
//  - a holder of the current key who is no longer on the roster (kicked,
//    banned or left) triggers a rotation to everyone still there.

import { compareEpochsForSend } from "@ishtarservices/core";
import type { SpaceEpochInfo, SpaceHistoryPolicy } from "@ishtarservices/shared-types";
import { store } from "@/store";
import { encryptedSpaceEntry } from "@/store/slices/spaceE2eeSlice";
import { fetchFreshRoster, type RosterSource } from "./freshRoster";
import {
  grantEpochs,
  isEncryptedSpace,
  isSpaceE2eeEnabled,
  isSpaceKeyManager,
  rotateSpaceKey,
  sendEpochOf,
  usableEpochs,
} from "./spaceKeyring";

export interface KeyReconcilePlan {
  /** Roster members to hand the key(s) to. Empty when rotating. */
  grantTo: string[];
  /** Start a new epoch for the roster. */
  rotate: boolean;
}

/**
 * Pure: what a manager must do given the roster and who holds the current
 * epoch's key. A roster that doesn't include the manager is not trusted (it
 * is stale or partial), so nothing happens.
 */
export function planKeyReconcile(roster: readonly string[], holders: readonly string[], me: string): KeyReconcilePlan {
  if (!roster.includes(me)) return { grantTo: [], rotate: false };
  const onRoster = new Set(roster);
  const holding = new Set(holders);
  if (holders.some((pk) => !onRoster.has(pk))) return { grantTo: [], rotate: true };
  return { grantTo: roster.filter((pk) => !holding.has(pk)), rotate: false };
}

/**
 * Pure: the epochs a new member is handed (docs/E2EE_SPACES.md §5.6).
 * `epoch` = the current one only; `full` = every epoch held, oldest first.
 */
export function epochsToGrant(policy: SpaceHistoryPolicy, held: readonly SpaceEpochInfo[]): SpaceEpochInfo[] {
  const newestFirst = [...held].sort(compareEpochsForSend);
  if (newestFirst.length === 0) return [];
  return policy === "full" ? newestFirst.reverse() : [newestFirst[0]];
}

let rosterSource: RosterSource = fetchFreshRoster;

/** How long a just-removed member is kept off the roster this device acts on.
 *  The authority's roster can lag a kick by a moment (the relay has not
 *  processed the 9001 yet); without this the next pass would hand the new key
 *  straight back. */
const REMOVED_TTL_MS = 10 * 60_000;
/** spaceId -> pubkey -> when the exclusion lapses. */
const recentlyRemoved = new Map<string, Map<string, number>>();

function activeExclusions(spaceId: string, roster: readonly string[], now: number): Set<string> {
  const entries = recentlyRemoved.get(spaceId);
  const out = new Set<string>();
  if (!entries) return out;
  for (const [pk, until] of entries) {
    // Lapsed, or the roster caught up: nothing left to remember.
    if (until <= now || !roster.includes(pk)) entries.delete(pk);
    else out.add(pk);
  }
  if (entries.size === 0) recentlyRemoved.delete(spaceId);
  return out;
}

export interface ReconcileOptions {
  /** Pubkeys just removed from the space (the stored roster may not show it yet). */
  exclude?: string[];
}

async function reconcileOnce(spaceId: string, opts?: ReconcileOptions): Promise<void> {
  const state = store.getState();
  const me = state.identity.pubkey;
  const space = state.spaces.list.find((s) => s.id === spaceId);
  if (!me || !space || !isSpaceE2eeEnabled()) return;
  if (!isEncryptedSpace(spaceId) || !isSpaceKeyManager(spaceId, me)) return;
  if (!sendEpochOf(spaceId)) return;

  // Remember a removal before anything can fail: if the roster fetch below
  // doesn't answer, the next pass must still know this member is out.
  const now = Date.now();
  if (opts?.exclude?.length) {
    let entries = recentlyRemoved.get(spaceId);
    if (!entries) {
      entries = new Map();
      recentlyRemoved.set(spaceId, entries);
    }
    for (const pk of opts.exclude) if (pk !== me) entries.set(pk, now + REMOVED_TTL_MS);
  }

  // Always the authority's roster as of now, never the store's cached copy.
  const fresh = await rosterSource(space);
  if (!fresh) return;
  // The key may have moved on while the roster was being fetched.
  const current = sendEpochOf(spaceId);
  if (!current) return;
  const explicit = new Set(opts?.exclude ?? []);
  const lagging = activeExclusions(spaceId, fresh, now);
  const roster = fresh.filter((pk) => !explicit.has(pk) && !lagging.has(pk));
  // Read after the fetch: grants may have arrived meanwhile.
  const holders = encryptedSpaceEntry(store.getState().spaceE2ee.spaces, spaceId)?.holders[current.info.id] ?? [];
  const plan = planKeyReconcile(roster, holders, me);

  if (plan.rotate) {
    await rotateSpaceKey(spaceId, roster);
  } else if (plan.grantTo.length > 0) {
    await grantEpochs(spaceId, epochsToGrant(current.info.history, usableEpochs(spaceId)), plan.grantTo);
  }
}

// One pass at a time per space, in request order.
const chains = new Map<string, Promise<void>>();

/** Bring a space's key in step with its roster, if this account manages it. */
export function reconcileSpaceKeys(spaceId: string, opts?: ReconcileOptions): Promise<void> {
  const run = (chains.get(spaceId) ?? Promise.resolve())
    .then(() => reconcileOnce(spaceId, opts))
    .catch((err) => {
      console.error("[e2ee] key reconcile failed:", err instanceof Error ? err.message : "unknown error");
    });
  chains.set(spaceId, run);
  return run;
}

/** Test-only: forget remembered removals and queued passes, and optionally
 *  replace where the roster comes from. */
export function _resetKeyReconcile(source: RosterSource = fetchFreshRoster): void {
  recentlyRemoved.clear();
  chains.clear();
  rosterSource = source;
}
