import { store } from "../../../store";
import { relayManager } from "../relayManager";
import { EVENT_KINDS } from "../../../types/nostr";
import { PROFILE_RELAYS } from "../constants";
import { loadFollowerState, startFollowerPersistence } from "../followerPersistence";
import {
  setKnownFollowers,
  addKnownFollower,
} from "../../../store/slices/identitySlice";
import { loginState } from "./state";

// Followers: the cached set, then the live kind:3 subscription.

/** performLogin step 7h: cached followers, then the live follower subscription. */
export async function subscribeFollowers(pubkey: string): Promise<void> {
  // Step 7h: Load cached followers, then subscribe for kind:3 events that tag us.
  // Use all connected read relays (not just bootstrap) so user-configured relays are included.
  // Buffer follower pubkeys until EOSE, then MERGE with cached set (never shrink).
  await loadFollowerState();
  loginState.cleanupFollowerPersistence = startFollowerPersistence();

  const followerBuffer: string[] = [];
  let followerMerged = false;

  const mergeFollowers = () => {
    if (followerMerged) return;
    // #77 — the 10s safety timer (and the standing subscription) can fire AFTER an
    // account switch. Without this guard, account A's buffered followers get merged
    // into account B's knownFollowers (and persisted there). Bail if we're no longer
    // the active identity.
    if (store.getState().identity.pubkey !== pubkey) return;
    followerMerged = true;
    clearTimeout(followerTimer);
    // Merge buffered followers with cached set — always union, never replace with smaller
    const cached = store.getState().identity.knownFollowers;
    const merged = Array.from(new Set([...cached, ...followerBuffer]));
    store.dispatch(setKnownFollowers(merged));
  };

  relayManager.subscribe({
    filters: [
      {
        kinds: [EVENT_KINDS.FOLLOW_LIST],
        "#p": [pubkey],
        limit: 500,
      },
    ],
    relayUrls: PROFILE_RELAYS,
    onEvent: (event) => {
      // Stale-subscription guard (#77): ignore deliveries after an account switch.
      if (store.getState().identity.pubkey !== pubkey) return;
      // Only care about events that include us in their follow list
      if (event.pubkey === pubkey) return;
      const followsUs = event.tags.some(
        (t) => t[0] === "p" && t[1] === pubkey,
      );
      if (!followsUs) return;

      if (!followerMerged) {
        // Still buffering — collect pubkeys
        if (!followerBuffer.includes(event.pubkey)) {
          followerBuffer.push(event.pubkey);
        }
      } else {
        // Post-merge: genuinely new follower
        store.dispatch(addKnownFollower(event.pubkey));
      }
    },
    onEOSE: mergeFollowers,
  });

  // Safety: merge whatever we have if no EOSE arrives
  const followerTimer = setTimeout(mergeFollowers, 10_000);
}
