// Keychain storage for the epoch keys of encrypted spaces
// (docs/E2EE_SPACES.md §5.5), scoped per account:
//
//   space.e2ee.<accountpk>.<spaceId> = {"v":1,"keys":{"<epochId>":"<64 hex>"}}
//   space.e2ee.index.<accountpk>     = {"v":1,"spaces":["<spaceId>", …]}
//
// The keystore can't enumerate, so the index lists the slots. Secrets go
// through secretStore only: never Redux, IndexedDB or a log. On web that means
// session memory unless the user opted in to persistence; a device that lost
// its cache re-derives every key from the space's grant events.

import { deleteSecret, getSecret, setSecret } from "@/lib/nostr/secretStore";

const HEX64_RE = /^[0-9a-f]{64}$/;
const EPOCH_ID_RE = /^[0-9a-f]{16}$/;

/** Epochs kept per space; the oldest are dropped past this (they can be
 *  re-derived from grants). Bounds the keychain blob. */
export const MAX_STORED_EPOCHS = 128;

export function spaceKeySlot(accountPubkey: string, spaceId: string): string {
  return `space.e2ee.${accountPubkey}.${spaceId}`;
}

export function spaceKeyIndexSlot(accountPubkey: string): string {
  return `space.e2ee.index.${accountPubkey}`;
}

function parseKeys(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; keys?: unknown };
    if (parsed.v !== 1 || typeof parsed.keys !== "object" || parsed.keys === null) return {};
    const out: Record<string, string> = {};
    for (const [id, key] of Object.entries(parsed.keys as Record<string, unknown>)) {
      if (EPOCH_ID_RE.test(id) && typeof key === "string" && HEX64_RE.test(key)) out[id] = key;
    }
    return out;
  } catch {
    return {};
  }
}

function parseIndex(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; spaces?: unknown };
    if (parsed.v !== 1 || !Array.isArray(parsed.spaces)) return [];
    return [...new Set(parsed.spaces.filter((s): s is string => typeof s === "string" && s.length > 0))];
  } catch {
    return [];
  }
}

// Writes are read-modify-write on one keychain blob; serialize them so a burst
// of grants can't drop each other's keys.
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/** Every stored epoch key of a space: epochId -> key hex. */
export async function loadSpaceKeys(accountPubkey: string, spaceId: string): Promise<Record<string, string>> {
  return parseKeys(await getSecret(spaceKeySlot(accountPubkey, spaceId)));
}

/** Space ids with stored keys. */
export async function listSpacesWithKeys(accountPubkey: string): Promise<string[]> {
  return parseIndex(await getSecret(spaceKeyIndexSlot(accountPubkey)));
}

/** Store one epoch key. Throws when the keychain write fails. */
export function saveSpaceKey(
  accountPubkey: string,
  spaceId: string,
  epochId: string,
  keyHex: string,
): Promise<void> {
  if (!EPOCH_ID_RE.test(epochId) || !HEX64_RE.test(keyHex)) {
    return Promise.reject(new Error("invalid space key"));
  }
  return serialized(async () => {
    const keys = await loadSpaceKeys(accountPubkey, spaceId);
    if (keys[epochId] === keyHex) return;
    keys[epochId] = keyHex;
    const ids = Object.keys(keys);
    // Insertion order is acceptance order; drop the oldest past the bound.
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_STORED_EPOCHS))) delete keys[id];
    await setSecret(spaceKeySlot(accountPubkey, spaceId), JSON.stringify({ v: 1, keys }));

    const index = parseIndex(await getSecret(spaceKeyIndexSlot(accountPubkey)));
    if (!index.includes(spaceId)) {
      index.push(spaceId);
      await setSecret(spaceKeyIndexSlot(accountPubkey), JSON.stringify({ v: 1, spaces: index }));
    }
  });
}

/** Delete every key of a space on this device. */
export function forgetSpaceKeys(accountPubkey: string, spaceId: string): Promise<void> {
  return serialized(async () => {
    await deleteSecret(spaceKeySlot(accountPubkey, spaceId));
    const index = parseIndex(await getSecret(spaceKeyIndexSlot(accountPubkey)));
    if (index.includes(spaceId)) {
      await setSecret(
        spaceKeyIndexSlot(accountPubkey),
        JSON.stringify({ v: 1, spaces: index.filter((s) => s !== spaceId) }),
      );
    }
  });
}
