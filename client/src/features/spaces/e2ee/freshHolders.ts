// Who holds an epoch's key, as the relay actually serves it
// (docs/E2EE_SPACES.md §5.2–5.3).
//
// A key reconcile compares the roster with the holders of the current epoch.
// Like the roster, the holders are fetched at that moment, from the grants the
// space's relay returns: a grant that was signed but refused by the relay hands
// nobody a key, and a local "I granted them" note would hide that forever.
//
// Only grants that check out count: signed by the space's key root or a
// manager of the epoch, verified, for the epoch in question, and whose payload
// opens under the epoch key this device holds.

import { openSpaceKeyGrantWithKey, readGrantHeader } from "@ishtarservices/core";
import type { SpaceEpochInfo } from "@ishtarservices/shared-types";
import { relayManager } from "@/lib/nostr/relayManager";
import { verifyBridge } from "@/lib/nostr/verifyWorkerBridge";
import { EVENT_KINDS, type NostrEvent } from "@/types/nostr";
import type { Space } from "@/types/space";
import { fetchAllPaged, type PagedReqTransport } from "./pagedReq";

/** Grants for an epoch are published at or after the epoch was made; allow
 *  for a manager whose clock runs behind. */
const EPOCH_START_SKEW_SEC = 600;

export interface HoldersQuery {
  space: Space;
  epoch: SpaceEpochInfo;
  key: Uint8Array;
  root: string;
}

export type HoldersSource = (query: HoldersQuery) => Promise<string[] | null>;

const relayTransport: PagedReqTransport = {
  subscribe: (opts) => relayManager.subscribe(opts),
  close: (subId) => relayManager.closeSubscription(subId),
};

/**
 * Every pubkey a valid grant for `epoch` names, from the space's host relay.
 * Null when the relay could not be asked to the end (timeout, page limit): the
 * caller must then do nothing, not treat the partial answer as the truth.
 */
export async function fetchEpochHolders(
  query: HoldersQuery,
  transport: PagedReqTransport = relayTransport,
): Promise<string[] | null> {
  const { space, epoch, key, root } = query;
  if (!space.hostRelay) return null;
  relayManager.connect(space.hostRelay, "read+write");

  const candidates: NostrEvent[] = [];
  const result = await fetchAllPaged(transport, {
    filter: {
      kinds: [EVENT_KINDS.SPACE_KEY_GRANT],
      "#h": [space.id],
      since: Math.max(0, epoch.at - EPOCH_START_SKEW_SEC),
    },
    relayUrl: space.hostRelay,
    onEvent: (event) => {
      const header = readGrantHeader(event);
      if (!header || header.spaceId !== space.id || header.epochId !== epoch.id) return;
      if (event.pubkey !== root && !epoch.managers.includes(event.pubkey)) return;
      candidates.push(event);
    },
  });
  if (!result.complete) return null;

  const holders = new Set<string>();
  for (const event of candidates) {
    const valid = await verifyBridge.verify(event).catch(() => false);
    if (!valid) continue;
    try {
      openSpaceKeyGrantWithKey(event, key);
    } catch {
      continue;
    }
    for (const pk of readGrantHeader(event)!.recipients) holders.add(pk);
  }
  return [...holders];
}
