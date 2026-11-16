import { store } from "../../../store";
import { subscriptionManager } from "../subscriptionManager";
import { EVENT_KINDS } from "../../../types/nostr";
import { saveUserState, getUserState } from "../../db/userStateStore";
import { BOOTSTRAP_RELAYS } from "../constants";
import { startGiftWrapReconciliation } from "../../../features/dm/dmSync";
import { loginState } from "./state";

// The gift-wrap (kind:1059) inbox subscription opened at login.

/** performLogin step 7g: the gift-wrap (kind:1059) subscription and inbox reconciliation. */
export async function subscribeGiftWraps(pubkey: string): Promise<void> {
  // Step 7g: Subscribe for gift-wrapped DMs (kind:1059) addressed to us.
  // Use a persisted timestamp so we catch all wraps since the last session.
  // NIP-17 randomizes created_at up to 2 days back, so subtract a 3-day buffer
  // from our last-seen timestamp to avoid missing events.
  const THREE_DAYS = 3 * 24 * 60 * 60;
  const lastGiftWrapTs = await getUserState<number>("last_gift_wrap_ts");
  const giftWrapFilter: import("../../../types/nostr").NostrFilter = {
    kinds: [EVENT_KINDS.GIFT_WRAP],
    "#p": [pubkey],
  };
  if (lastGiftWrapTs) {
    // Fetch all wraps since (lastSeen - 3 days) to account for NIP-17 timestamp randomization
    giftWrapFilter.since = lastGiftWrapTs - THREE_DAYS;
  } else {
    // First login: fetch a reasonable initial batch
    giftWrapFilter.limit = 200;
  }
  // Subscribe on DM relays (if known) plus bootstrap for transition coverage
  const dmRelays = store.getState().identity.dmRelayList;
  const giftWrapRelayUrls = dmRelays.length > 0
    ? [...new Set([...dmRelays, ...BOOTSTRAP_RELAYS])]
    : BOOTSTRAP_RELAYS;
  const giftWrapSubStartedAt = Math.floor(Date.now() / 1000);
  subscriptionManager.subscribe({
    filters: [giftWrapFilter],
    relayUrls: giftWrapRelayUrls,
    // Persist the watermark only once the backlog actually arrived: advancing
    // it before EOSE silently narrowed the next window after a failed sync.
    onEOSE: () => {
      if (store.getState().identity.pubkey !== pubkey) return;
      saveUserState("last_gift_wrap_ts", giftWrapSubStartedAt).catch(() => {});
    },
  });
  // NIP-77: reconcile the inbox by event id on relays that speak it
  // (docs/DM_WIRE_CONTRACT.md §7.5); the since-window sub above is the fallback.
  loginState.cleanupGiftWrapReconciliation?.();
  loginState.cleanupGiftWrapReconciliation = startGiftWrapReconciliation(pubkey, () => {
    const dm = store.getState().identity.dmRelayList;
    return dm.length > 0 ? [...new Set([...dm, ...BOOTSTRAP_RELAYS])] : [...BOOTSTRAP_RELAYS];
  });
}
