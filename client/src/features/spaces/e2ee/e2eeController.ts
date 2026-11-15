// Lifecycle of encrypted spaces for the logged-in account (docs/E2EE_SPACES.md):
// registers the pipeline hooks, keeps the grant and sealed-event subscriptions
// in step with the joined spaces, and runs the key reconcile when a managed
// space's roster changes. Its own subscriptions only: the regular channel and
// background chat subscriptions are untouched.
//
// With the feature off this only loads the account's record of which spaces
// are encrypted (the "never send plaintext there" rule holds either way); it
// opens no subscription and handles no event.

import { store, type RootState } from "@/store";
import { EVENT_KINDS, type NostrFilter } from "@/types/nostr";
import { subscriptionManager } from "@/lib/nostr/subscriptionManager";
import { registerSpaceE2eeHooks } from "@/lib/nostr/spaceE2eeHooks";
import type { Space } from "@/types/space";
import { resolveRelaySet } from "../relaySet";
import { reconcileSpaceKeys } from "./keyReconcile";
import { clearSealedChatSession, openSealedFromPipeline, releaseParked } from "./sealedChat";
import {
  clearSpaceE2eeSession,
  ensureSpaceE2eeHydrated,
  handleKeyGrant,
  isSpaceE2eeEnabled,
  isSpaceKeyManager,
  onSpaceEpochReady,
  retryPendingGrants,
} from "./spaceKeyring";

/** Recent-only window of the always-on sealed sub (history loads on entering). */
const BG_SINCE_SEC = 60;
/** Sealed events fetched when a space is opened (the relay's per-REQ maximum). */
const HISTORY_LIMIT = 500;
const RECONCILE_DEBOUNCE_MS = 1_000;

interface HostSub {
  subId: string;
  /** The space ids the sub was opened for, joined; reopened when it changes. */
  key: string;
}

let running = false;
let unsubscribeStore: (() => void) | null = null;
let stopEpochListener: (() => void) | null = null;
const grantSubs = new Map<string, HostSub>();
const bgSealedSubs = new Map<string, HostSub>();
let historySub: { spaceId: string; subId: string } | null = null;
const rosterSeen = new Map<string, readonly string[]>();
const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
let last: { enabled: boolean; list: Space[]; encrypted: RootState["spaceE2ee"]["spaces"]; active: string | null } | null =
  null;

function closeAll(subs: Map<string, HostSub>): void {
  for (const sub of subs.values()) subscriptionManager.close(sub.subId);
  subs.clear();
}

function syncHostSubs(subs: Map<string, HostSub>, byHost: Map<string, string[]>, filterFor: (ids: string[]) => NostrFilter): void {
  for (const [host, sub] of subs) {
    if (!byHost.has(host)) {
      subscriptionManager.close(sub.subId);
      subs.delete(host);
    }
  }
  for (const [host, ids] of byHost) {
    const key = [...ids].sort().join(",");
    const existing = subs.get(host);
    if (existing?.key === key) continue;
    if (existing) subscriptionManager.close(existing.subId);
    subs.set(host, { key, subId: subscriptionManager.subscribe({ filters: [filterFor(ids)], relayUrls: [host] }) });
  }
}

function groupByHost(spaces: Space[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const space of spaces) {
    if (!space.hostRelay || !space.id) continue;
    const ids = out.get(space.hostRelay) ?? [];
    ids.push(space.id);
    out.set(space.hostRelay, ids);
  }
  return out;
}

function scheduleReconcile(spaceId: string): void {
  const pending = reconcileTimers.get(spaceId);
  if (pending) clearTimeout(pending);
  reconcileTimers.set(
    spaceId,
    setTimeout(() => {
      reconcileTimers.delete(spaceId);
      void reconcileSpaceKeys(spaceId);
    }, RECONCILE_DEBOUNCE_MS),
  );
}

function sync(): void {
  if (!running) return;
  const state = store.getState();
  const enabled = isSpaceE2eeEnabled() && !!state.identity.pubkey && state.spaceE2ee.hydrated;
  const snapshot = {
    enabled,
    list: state.spaces.list,
    encrypted: state.spaceE2ee.spaces,
    active: state.spaces.activeSpaceId,
  };
  if (
    last &&
    last.enabled === snapshot.enabled &&
    last.list === snapshot.list &&
    last.encrypted === snapshot.encrypted &&
    last.active === snapshot.active
  ) {
    return;
  }
  last = snapshot;

  if (!enabled) {
    closeAll(grantSubs);
    closeAll(bgSealedSubs);
    if (historySub) {
      subscriptionManager.close(historySub.subId);
      historySub = null;
    }
    return;
  }

  // Grants for every joined space: this is how a device learns a space is
  // encrypted, receives its keys, and (as a manager) sees who holds them.
  syncHostSubs(grantSubs, groupByHost(state.spaces.list), (ids) => ({
    kinds: [EVENT_KINDS.SPACE_KEY_GRANT],
    "#h": ids,
  }));

  const encryptedSpaces = state.spaces.list.filter((s) => state.spaceE2ee.spaces[s.id]);
  syncHostSubs(bgSealedSubs, groupByHost(encryptedSpaces), (ids) => ({
    kinds: [EVENT_KINDS.SPACE_SEALED_EVENT],
    "#h": ids,
    since: Math.floor(Date.now() / 1000) - BG_SINCE_SEC,
  }));

  // History for the space on screen.
  const activeSpace = encryptedSpaces.find((s) => s.id === state.spaces.activeSpaceId);
  if (historySub && historySub.spaceId !== activeSpace?.id) {
    subscriptionManager.close(historySub.subId);
    historySub = null;
  }
  if (activeSpace && !historySub) {
    historySub = {
      spaceId: activeSpace.id,
      subId: subscriptionManager.subscribe({
        filters: [{ kinds: [EVENT_KINDS.SPACE_SEALED_EVENT], "#h": [activeSpace.id], limit: HISTORY_LIMIT }],
        relayUrls: resolveRelaySet(activeSpace),
      }),
    };
    void retryPendingGrants();
  }

  // A managed space whose roster changed needs a key hand-over or a rotation.
  for (const space of encryptedSpaces) {
    const seen = rosterSeen.get(space.id);
    if (seen === space.memberPubkeys) continue;
    rosterSeen.set(space.id, space.memberPubkeys);
    if (isSpaceKeyManager(space.id)) scheduleReconcile(space.id);
  }
}

/** Start for the logged-in account. Idempotent. */
export function startSpaceE2ee(): void {
  if (running) return;
  running = true;
  registerSpaceE2eeHooks({
    onKeyGrant: (event) => handleKeyGrant(event),
    openSealed: openSealedFromPipeline,
  });
  stopEpochListener = onSpaceEpochReady((spaceId, epochId) => {
    void releaseParked(spaceId, epochId);
    // Holding a key can make this account a manager: check the roster again.
    rosterSeen.delete(spaceId);
    last = null;
    sync();
  });
  unsubscribeStore = store.subscribe(sync);
  void ensureSpaceE2eeHydrated().then(sync);
}

/** Stop and forget everything in memory; call on logout and account switch. */
export function stopSpaceE2ee(): void {
  if (!running) return;
  running = false;
  unsubscribeStore?.();
  unsubscribeStore = null;
  stopEpochListener?.();
  stopEpochListener = null;
  registerSpaceE2eeHooks(null);
  closeAll(grantSubs);
  closeAll(bgSealedSubs);
  if (historySub) subscriptionManager.close(historySub.subId);
  historySub = null;
  for (const timer of reconcileTimers.values()) clearTimeout(timer);
  reconcileTimers.clear();
  rosterSeen.clear();
  last = null;
  clearSealedChatSession();
  clearSpaceE2eeSession();
}
