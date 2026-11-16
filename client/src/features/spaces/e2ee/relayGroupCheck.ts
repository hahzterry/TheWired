// Does a NIP-29 relay host a group under the id we asked for?
//
// An encrypted space's id commits to its key root (docs/E2EE_SPACES.md §5.4),
// so it must be created under exactly that id. A relay that assigns its own
// group ids (or refuses ours) can't host one: creation must fail clearly
// instead of producing a group whose id commits to nothing.

import { relayManager } from "@/lib/nostr/relayManager";
import { normalizeRelayUrl } from "@/lib/nostr/relayUrl";
import { EVENT_KINDS, type NostrEvent } from "@/types/nostr";

export const RELAY_CANNOT_HOST_MESSAGE =
  "This relay can't host an encrypted space: it didn't create the group under the space's id. Pick another relay.";

/** Publish the signed kind-9007 and wait for the relay to accept it. */
export async function createGroupConfirmed(signed: NostrEvent, relayUrl: string): Promise<void> {
  relayManager.connect(relayUrl, "read+write");
  const results = await relayManager.publishWithConfirmation(signed, [relayUrl]);
  const host = normalizeRelayUrl(relayUrl);
  const verdict = results.find((r) => normalizeRelayUrl(r.relayUrl) === host);
  if (!verdict?.success) throw new Error(RELAY_CANNOT_HOST_MESSAGE);
}

/**
 * Resolve true once the relay serves its own kind-39000 for `groupId` (signed
 * by its key), false if it doesn't within `timeoutMs`.
 */
export function relayServesGroup(
  relayUrl: string,
  groupId: string,
  relayPubkey: string,
  timeoutMs = 6_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let subId = "";
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (subId) relayManager.closeSubscription(subId);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      subId = relayManager.subscribe({
        filters: [{ kinds: [EVENT_KINDS.GROUP_METADATA], authors: [relayPubkey], "#d": [groupId], limit: 1 }],
        relayUrls: [relayUrl],
        onEvent: (event: NostrEvent) => {
          if (event.pubkey === relayPubkey && event.tags.some((t) => t[0] === "d" && t[1] === groupId)) finish(true);
        },
        // Metadata is published right after the 9007; an empty first answer
        // is not final, the timeout is.
        onEOSE: () => {},
      });
    } catch {
      finish(false);
    }
  });
}
