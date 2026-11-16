// The roster a key reconcile acts on (docs/E2EE_SPACES.md §5.2–5.3) is always
// fetched from its authority at that moment, never taken from the store: the
// store's copy is a cache that can be a session old, and acting on it would
// rotate out members who joined since or hand the key to members who left.
//
//  - Backend-backed spaces: the backend's member list.
//  - NIP-29-native spaces: the host relay's newest kind-39002, accepted only
//    when signed by the relay key pinned for the space.
//
// Null means "could not get a roster worth acting on": the reconcile then does
// nothing and a later trigger tries again.

import { fetchAllMemberRoles } from "@/lib/api/roles";
import { relayManager } from "@/lib/nostr/relayManager";
import { verifyBridge } from "@/lib/nostr/verifyWorkerBridge";
import { EVENT_KINDS, type NostrEvent } from "@/types/nostr";
import type { Space } from "@/types/space";
import { isBackendBacked } from "../spaceType";

const HEX64_RE = /^[0-9a-f]{64}$/;
const NATIVE_ROSTER_TIMEOUT_MS = 6_000;

export type RosterSource = (space: Space) => Promise<string[] | null>;

async function backendRoster(space: Space): Promise<string[] | null> {
  try {
    const members = await fetchAllMemberRoles(space.id);
    const pubkeys = [...new Set(members.map((m) => m.pubkey).filter((pk) => HEX64_RE.test(pk)))];
    return pubkeys.length > 0 ? pubkeys : null;
  } catch {
    return null;
  }
}

function nativeRoster(space: Space): Promise<string[] | null> {
  const relayPubkey = space.relayPubkey;
  // Without the pinned relay key anyone could forge the member list.
  if (!relayPubkey || !space.hostRelay) return Promise.resolve(null);

  return new Promise((resolve) => {
    let newest: NostrEvent | null = null;
    let settled = false;
    const finish = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      relayManager.closeSubscription(subId);
      if (!newest) return resolve(null);
      const valid = await verifyBridge.verify(newest).catch(() => false);
      if (!valid) return resolve(null);
      const members = newest.tags.filter((t) => t[0] === "p" && HEX64_RE.test(t[1] ?? "")).map((t) => t[1]);
      resolve(members.length > 0 ? [...new Set(members)] : null);
    };
    relayManager.connect(space.hostRelay, "read+write");
    const subId = relayManager.subscribe({
      filters: [{ kinds: [EVENT_KINDS.GROUP_MEMBERS], authors: [relayPubkey], "#d": [space.id], limit: 1 }],
      relayUrls: [space.hostRelay],
      onEvent: (event: NostrEvent) => {
        if (event.kind !== EVENT_KINDS.GROUP_MEMBERS || event.pubkey !== relayPubkey) return;
        if (event.tags.find((t) => t[0] === "d")?.[1] !== space.id) return;
        if (!newest || event.created_at > newest.created_at) newest = event;
      },
      onEOSE: () => void finish(),
    });
    const timer = setTimeout(() => void finish(), NATIVE_ROSTER_TIMEOUT_MS);
  });
}

/** The space's current members straight from its authority, or null. */
export const fetchFreshRoster: RosterSource = (space) =>
  isBackendBacked(space) ? backendRoster(space) : nativeRoster(space);
