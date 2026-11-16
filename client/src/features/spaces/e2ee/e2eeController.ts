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
import { EVENT_KINDS, type NostrEvent, type NostrFilter } from "@/types/nostr";
import { subscriptionManager } from "@/lib/nostr/subscriptionManager";
import { registerSpaceE2eeHooks } from "@/lib/nostr/spaceE2eeHooks";
import { encryptedSpaceEntry, isSpaceE2eeLoadedFor } from "@/store/slices/spaceE2eeSlice";
import { processIncomingEvent } from "@/lib/nostr/eventPipeline";
import { relayManager } from "@/lib/nostr/relayManager";
import { fetchAllPaged, type PagedReqTransport } from "./pagedReq";
import type { Space } from "@/types/space";
import { resolveRelaySet } from "../relaySet";
import { clearKeyReconcile, reconcileSpaceKeys } from "./keyReconcile";
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
const RECONCILE_DEBOUNCE_MS = 1_500;
/** Wait after a space is opened before checking its keys against its roster:
 *  the roster refetch and the grant subscription both need a moment. */
const RECONCILE_ON_OPEN_MS = 5_000;

/**
 * A REQ that reaches the relay before NIP-42 AUTH completes is answered as an
 * anonymous one: an empty EOSE, never re-run. That is the normal state on a
 * cold start, because these subscriptions open as soon as the account loads.
 * So a stored query that came back empty is asked again a few times with
 * backoff, until something arrives or the tries run out (a space with no
 * grants at all costs these few extra REQs once per launch).
 */
const EMPTY_RETRY_BASE_MS = 1_500;
const MAX_EMPTY_RETRIES = 5;

interface HostSub {
  subId: string;
  /** The space ids the sub was opened for, joined; reopened when it changes. */
  key: string;
  retry: ReturnType<typeof setTimeout> | null;
}

/** `${kind}:${spaceId}` for every contract event the pipeline handed over. */
const delivered = new Set<string>();

function noteDelivered(event: NostrEvent): void {
  const spaceId = event.tags.find((t) => t[0] === "h")?.[1];
  if (spaceId) delivered.add(`${event.kind}:${spaceId}`);
}

function closeSub(sub: { subId: string; retry: ReturnType<typeof setTimeout> | null }): void {
  if (sub.retry) clearTimeout(sub.retry);
  subscriptionManager.close(sub.subId);
}

/**
 * Open a stored-events subscription that re-asks while it stays empty.
 * `isCurrent` tells whether `entry` is still the live subscription for its
 * slot, so a retry never resurrects one that was closed or replaced.
 */
function subscribeWithEmptyRetry<T extends { subId: string; retry: ReturnType<typeof setTimeout> | null }>(
  entry: T,
  kind: number,
  spaceIds: string[],
  filter: NostrFilter,
  relayUrls: string[],
  isCurrent: (entry: T) => boolean,
  attempt = 0,
): void {
  entry.subId = subscriptionManager.subscribe({
    filters: [filter],
    relayUrls,
    onEOSE: () => {
      if (!running || !isCurrent(entry) || attempt >= MAX_EMPTY_RETRIES) return;
      if (spaceIds.some((id) => delivered.has(`${kind}:${id}`))) return;
      entry.retry = setTimeout(() => {
        entry.retry = null;
        if (!running || !isCurrent(entry)) return;
        if (spaceIds.some((id) => delivered.has(`${kind}:${id}`))) return;
        subscriptionManager.close(entry.subId);
        subscribeWithEmptyRetry(entry, kind, spaceIds, filter, relayUrls, isCurrent, attempt + 1);
      }, EMPTY_RETRY_BASE_MS * 2 ** attempt);
    },
  });
}

let running = false;
let unsubscribeStore: (() => void) | null = null;
let stopEpochListener: (() => void) | null = null;
const grantSubs = new Map<string, HostSub>();
const bgSealedSubs = new Map<string, HostSub>();
let historySub: { spaceId: string; subId: string; retry: ReturnType<typeof setTimeout> | null } | null = null;
const rosterSeen = new Map<string, readonly string[]>();
const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
let last: { enabled: boolean; list: Space[]; encrypted: RootState["spaceE2ee"]["spaces"]; active: string | null } | null =
  null;

// ── This account's grants, paged ─────────────────────────────────────────────
// The live grant subscription asks the relay once, for everything in the
// joined spaces, and a relay answers one REQ with at most 500 events: on a
// relay whose spaces hold more grants than that, the ones addressed to this
// account can be past the cap and never seen. So the grants this device needs
// (those naming it) are also fetched to the end, page by page.

const relayTransport: PagedReqTransport = {
  subscribe: (opts) => relayManager.subscribe(opts),
  close: (subId) => relayManager.closeSubscription(subId),
};

/** host -> the space ids last fetched for, joined. */
const keyFetched = new Map<string, string>();
const keyFetchTimers = new Set<ReturnType<typeof setTimeout>>();

function fetchMyGrants(host: string, ids: string[], me: string, attempt = 0): void {
  const key = [...ids].sort().join(",");
  keyFetched.set(host, key);
  void fetchAllPaged(relayTransport, {
    filter: { kinds: [EVENT_KINDS.SPACE_KEY_GRANT], "#h": ids, "#p": [me] },
    relayUrl: host,
    onEvent: (event, relayUrl) => void processIncomingEvent(event, relayUrl),
    cancelled: () => !running || keyFetched.get(host) !== key,
  }).then((result) => {
    if (!running || keyFetched.get(host) !== key) return;
    // An empty answer is also what a REQ sent before NIP-42 AUTH completes
    // gets; ask again a few times unless something addressed to us arrived.
    if (result.count > 0 || attempt >= MAX_EMPTY_RETRIES) return;
    if (ids.some((id) => delivered.has(`${EVENT_KINDS.SPACE_KEY_GRANT}:${id}`))) return;
    const timer = setTimeout(() => {
      keyFetchTimers.delete(timer);
      if (running && keyFetched.get(host) === key) fetchMyGrants(host, ids, me, attempt + 1);
    }, EMPTY_RETRY_BASE_MS * 2 ** attempt);
    keyFetchTimers.add(timer);
  }, () => {
    // Never reached (fetchAllPaged settles every page); the live subscription
    // and the next sync cover a failure.
  });
}

function syncKeyFetches(byHost: Map<string, string[]>, me: string): void {
  for (const host of [...keyFetched.keys()]) if (!byHost.has(host)) keyFetched.delete(host);
  for (const [host, ids] of byHost) {
    if (keyFetched.get(host) === [...ids].sort().join(",")) continue;
    fetchMyGrants(host, ids, me);
  }
}

function closeAll(subs: Map<string, HostSub>): void {
  for (const sub of subs.values()) closeSub(sub);
  subs.clear();
}

/** Keep one subscription per host relay in step with the space ids on it.
 *  `retryKind` set = a stored query worth re-asking while it stays empty. */
function syncHostSubs(
  subs: Map<string, HostSub>,
  byHost: Map<string, string[]>,
  filterFor: (ids: string[]) => NostrFilter,
  retryKind: number | null,
): void {
  for (const [host, sub] of subs) {
    if (!byHost.has(host)) {
      closeSub(sub);
      subs.delete(host);
    }
  }
  for (const [host, ids] of byHost) {
    const key = [...ids].sort().join(",");
    const existing = subs.get(host);
    if (existing?.key === key) continue;
    if (existing) closeSub(existing);
    const entry: HostSub = { key, subId: "", retry: null };
    subs.set(host, entry);
    if (retryKind === null) {
      entry.subId = subscriptionManager.subscribe({ filters: [filterFor(ids)], relayUrls: [host] });
    } else {
      subscribeWithEmptyRetry(entry, retryKind, ids, filterFor(ids), [host], (e) => subs.get(host) === e);
    }
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

function scheduleReconcile(spaceId: string, delayMs: number = RECONCILE_DEBOUNCE_MS): void {
  const pending = reconcileTimers.get(spaceId);
  if (pending) clearTimeout(pending);
  reconcileTimers.set(
    spaceId,
    setTimeout(() => {
      reconcileTimers.delete(spaceId);
      void reconcileSpaceKeys(spaceId);
    }, delayMs),
  );
}

function sync(): void {
  if (!running) return;
  const state = store.getState();
  const enabled = isSpaceE2eeEnabled() && !!state.identity.pubkey && isSpaceE2eeLoadedFor(state);
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
    keyFetched.clear();
    closeAll(grantSubs);
    closeAll(bgSealedSubs);
    if (historySub) {
      closeSub(historySub);
      historySub = null;
    }
    return;
  }

  // Grants for every joined space: this is how a device learns a space is
  // encrypted, receives its keys, and (as a manager) sees who holds them.
  const joinedByHost = groupByHost(state.spaces.list);
  syncHostSubs(
    grantSubs,
    joinedByHost,
    (ids) => ({ kinds: [EVENT_KINDS.SPACE_KEY_GRANT], "#h": ids }),
    EVENT_KINDS.SPACE_KEY_GRANT,
  );
  syncKeyFetches(joinedByHost, state.identity.pubkey!);

  const encryptedSpaces = state.spaces.list.filter((s) => encryptedSpaceEntry(state.spaceE2ee.spaces, s.id));
  // Live only (a recent `since`), so an empty answer is the normal one.
  syncHostSubs(
    bgSealedSubs,
    groupByHost(encryptedSpaces),
    (ids) => ({
      kinds: [EVENT_KINDS.SPACE_SEALED_EVENT],
      "#h": ids,
      since: Math.floor(Date.now() / 1000) - BG_SINCE_SEC,
    }),
    null,
  );

  // History for the space on screen.
  const activeSpace = encryptedSpaces.find((s) => s.id === state.spaces.activeSpaceId);
  if (historySub && historySub.spaceId !== activeSpace?.id) {
    closeSub(historySub);
    historySub = null;
  }
  if (activeSpace && !historySub) {
    const entry = { spaceId: activeSpace.id, subId: "", retry: null };
    historySub = entry;
    subscribeWithEmptyRetry(
      entry,
      EVENT_KINDS.SPACE_SEALED_EVENT,
      [activeSpace.id],
      { kinds: [EVENT_KINDS.SPACE_SEALED_EVENT], "#h": [activeSpace.id], limit: HISTORY_LIMIT },
      resolveRelaySet(activeSpace),
      (e) => historySub === e,
    );
    void retryPendingGrants();
    // Opening a managed space is also when a member left waiting (the signer
    // was away, or no manager was online when they joined) gets their key.
    if (isSpaceKeyManager(activeSpace.id)) scheduleReconcile(activeSpace.id, RECONCILE_ON_OPEN_MS);
  }

  // A managed space whose roster CHANGED needs a key hand-over or a rotation.
  // The roster first seen in a session is the cached one: acting on it could
  // rotate out a member who joined while this device was away, so it is only
  // remembered, and the first fresh roster is what gets compared.
  for (const space of encryptedSpaces) {
    const seen = rosterSeen.get(space.id);
    if (seen === space.memberPubkeys) continue;
    rosterSeen.set(space.id, space.memberPubkeys);
    if (seen !== undefined && isSpaceKeyManager(space.id)) scheduleReconcile(space.id);
  }
}

/** Start for the logged-in account. Idempotent. */
export function startSpaceE2ee(): void {
  if (running) return;
  running = true;
  registerSpaceE2eeHooks({
    onKeyGrant: (event) => {
      noteDelivered(event);
      return handleKeyGrant(event);
    },
    openSealed: (event, relayUrl) => {
      noteDelivered(event);
      return openSealedFromPipeline(event, relayUrl);
    },
  });
  stopEpochListener = onSpaceEpochReady((spaceId, epochId) => {
    void releaseParked(spaceId, epochId);
    last = null;
    sync();
  });
  unsubscribeStore = store.subscribe(sync);
  // A record that could not be read is retried on the next sync trigger.
  void ensureSpaceE2eeHydrated().then(sync, sync);
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
  if (historySub) closeSub(historySub);
  historySub = null;
  delivered.clear();
  keyFetched.clear();
  for (const timer of keyFetchTimers) clearTimeout(timer);
  keyFetchTimers.clear();
  clearKeyReconcile();
  for (const timer of reconcileTimers.values()) clearTimeout(timer);
  reconcileTimers.clear();
  rosterSeen.clear();
  last = null;
  clearSealedChatSession();
  clearSpaceE2eeSession();
}
