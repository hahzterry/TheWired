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

const MAX_PARKED_PER_EPOCH = 500;
const MAX_PARKED_EPOCHS = 64;

/** `${spaceId}:${epochId}` -> sealed events waiting for that key. */
const parked = new Map<string, Array<{ event: NostrEvent; relayUrl: string }>>();
/** Rumor ids already rendered, per space: a second outer event carrying the
 *  same rumor is a replay. */
const seenRumors = new LRUCache<string, true>({ max: 20_000 });

function park(spaceId: string, epochId: string, event: NostrEvent, relayUrl: string): void {
  const key = `${spaceId}:${epochId}`;
  let list = parked.get(key);
  if (!list) {
    if (parked.size >= MAX_PARKED_EPOCHS) {
      const oldest = parked.keys().next().value;
      if (oldest !== undefined) parked.delete(oldest);
    }
    list = [];
    parked.set(key, list);
  }
  if (list.some((p) => p.event.id === event.id)) return;
  if (list.length >= MAX_PARKED_PER_EPOCH) list.shift();
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
    park(header.spaceId, header.epochId, event, relayUrl);
    return { status: "parked" };
  }
  return open(event, key, header.spaceId);
}

/** An epoch key arrived: open and ingest everything parked for it. */
export async function releaseParked(spaceId: string, epochId: string): Promise<number> {
  const mapKey = `${spaceId}:${epochId}`;
  const list = parked.get(mapKey);
  const key = getEpochKey(spaceId, epochId);
  if (!list || !key) return 0;
  parked.delete(mapKey);
  let released = 0;
  for (const { event, relayUrl } of list) {
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
  for (const [key, list] of parked) if (key.startsWith(`${spaceId}:`)) n += list.length;
  return n;
}

/** Drop receive-side state; call on account switch and logout. */
export function clearSealedChatSession(): void {
  parked.clear();
  seenRumors.clear();
}

export { isEncryptedSpace };
