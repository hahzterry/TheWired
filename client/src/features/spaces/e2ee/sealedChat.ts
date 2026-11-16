// Sending and receiving chat in an encrypted space (docs/E2EE_SPACES.md §6.1).
//
// Send: the ordinary kind-9 event a channel would publish becomes the inner
// event of a sealed space event. Receive: the pipeline hands every verified
// sealed event here; it is opened with the epoch key its tag names, or parked
// until a grant brings that key.

import {
  SpaceE2eeError,
  buildSpaceRumor,
  openSealedSpaceEvent,
  readSealedHeader,
  sealSpaceEvent,
  sealedAsEvent,
} from "@ishtarservices/core";
import { LRUCache } from "lru-cache";
import { store } from "@/store";
import { ingestOpenedSealedEvent } from "@/lib/nostr/eventPipeline";
import type { SealedOpenResult } from "@/lib/nostr/spaceE2eeHooks";
import { forgetSeenEvents } from "@/lib/nostr/forgetSeen";
import type { NostrEvent, UnsignedEvent } from "@/types/nostr";
import {
  ensureSpaceE2eeHydrated,
  getEpochKey,
  isEncryptedSpace,
  isSpaceE2eeEnabled,
  sendEpochOf,
} from "./spaceKeyring";

/** Shown when the space is encrypted but this session has no key yet. */
export const NO_SPACE_KEY_MESSAGE = "Waiting for an admin to share this space's key.";

/**
 * Seal an unsigned space event (kind 9 with the space's `h` tag) for an
 * encrypted space. Returns the unsigned kind-4290 event to sign and publish.
 */
export async function sealForSpace(unsigned: UnsignedEvent, spaceId: string): Promise<UnsignedEvent> {
  await ensureSpaceE2eeHydrated();
  if (!isSpaceE2eeEnabled()) {
    throw new Error("Turn on Encrypted spaces in Settings → Features to post here.");
  }
  const current = sendEpochOf(spaceId);
  if (!current) throw new Error(NO_SPACE_KEY_MESSAGE);
  const rumor = buildSpaceRumor(
    unsigned.pubkey,
    spaceId,
    unsigned.kind,
    unsigned.tags,
    unsigned.content,
    unsigned.created_at,
  );
  return sealSpaceEvent(rumor, spaceId, current.key);
}

// ── Receive ──────────────────────────────────────────────────────────────────

/** Sealed events kept per author per space while their key is missing. A
 *  member who floods a space with sealed events under made-up epochs only
 *  ever evicts their own. */
const MAX_PARKED_PER_AUTHOR = 200;
/** Distinct authors with parked events per space. */
const MAX_PARKED_AUTHORS = 256;

interface Parked {
  event: NostrEvent;
  relayUrl: string;
}

/** spaceId -> author -> parked events, oldest first. */
const parked = new Map<string, Map<string, Parked[]>>();

/** Let an evicted event be fetched and judged again later: it was never
 *  opened, so the pipeline must not treat it as done. */
function release(events: Parked[]): void {
  forgetSeenEvents(events.map((p) => p.event.id));
}
/** Rumor ids already rendered, per space: a second outer event carrying the
 *  same rumor is a replay. */
const seenRumors = new LRUCache<string, true>({ max: 20_000 });

function park(spaceId: string, event: NostrEvent, relayUrl: string): void {
  let bySpace = parked.get(spaceId);
  if (!bySpace) {
    bySpace = new Map();
    parked.set(spaceId, bySpace);
  }
  let list = bySpace.get(event.pubkey);
  if (!list) {
    if (bySpace.size >= MAX_PARKED_AUTHORS) {
      release([{ event, relayUrl }]);
      return;
    }
    list = [];
    bySpace.set(event.pubkey, list);
  }
  if (list.some((p) => p.event.id === event.id)) return;
  if (list.length >= MAX_PARKED_PER_AUTHOR) release(list.splice(0, 1));
  list.push({ event, relayUrl });
}

function open(event: NostrEvent, key: Uint8Array, spaceId: string): SealedOpenResult {
  let rumor;
  try {
    rumor = openSealedSpaceEvent(event, key);
  } catch (err) {
    if (err instanceof SpaceE2eeError) return { status: "rejected" };
    throw err;
  }
  const replayKey = `${spaceId}:${rumor.id}`;
  if (seenRumors.has(replayKey)) return { status: "rejected" };
  seenRumors.set(replayKey, true);
  return { status: "opened", event: sealedAsEvent(event, rumor) };
}

/** Pipeline hook: a verified kind-4290 event arrived from `relayUrl`. */
export function openSealedFromPipeline(event: NostrEvent, relayUrl: string): SealedOpenResult {
  if (!isSpaceE2eeEnabled() || !store.getState().identity.pubkey) return { status: "declined" };
  const header = readSealedHeader(event);
  if (!header) return { status: "rejected" };
  if (!store.getState().spaces.list.some((s) => s.id === header.spaceId)) return { status: "declined" };

  const key = getEpochKey(header.spaceId, header.epochId);
  if (!key) {
    // Not held (yet): a grant may still be on its way, or the keychain is
    // still loading. Never rendered as text; kept until the key shows up.
    park(header.spaceId, event, relayUrl);
    return { status: "parked" };
  }
  return open(event, key, header.spaceId);
}

/** An epoch key arrived: open and ingest everything parked for it. */
export async function releaseParked(spaceId: string, epochId: string): Promise<number> {
  const bySpace = parked.get(spaceId);
  const key = getEpochKey(spaceId, epochId);
  if (!bySpace || !key) return 0;
  const ready: Parked[] = [];
  for (const [author, list] of bySpace) {
    const keep = list.filter((p) => {
      if (readSealedHeader(p.event)?.epochId !== epochId) return true;
      ready.push(p);
      return false;
    });
    if (keep.length > 0) bySpace.set(author, keep);
    else bySpace.delete(author);
  }
  if (bySpace.size === 0) parked.delete(spaceId);
  let released = 0;
  for (const { event, relayUrl } of ready) {
    const result = open(event, key, spaceId);
    if (result.status !== "opened") continue;
    await ingestOpenedSealedEvent(result.event, relayUrl);
    released++;
  }
  return released;
}

/** How many sealed events are waiting for keys in a space (for the UI). */
export function parkedCount(spaceId: string): number {
  let n = 0;
  for (const list of parked.get(spaceId)?.values() ?? []) n += list.length;
  return n;
}

/** Drop receive-side state; call on account switch and logout. */
export function clearSealedChatSession(): void {
  for (const bySpace of parked.values()) for (const list of bySpace.values()) release(list);
  parked.clear();
  seenRumors.clear();
}

export { isEncryptedSpace };
