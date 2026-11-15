import { store } from "../../../store";
import {
  setRelayList,
  setDMRelayList,
} from "../../../store/slices/identitySlice";
import { relayManager } from "../relayManager";
import { parseRelayList } from "../nip65";
import { parseDMRelayList } from "../dmRelayList";
import { ensureAppRelayInOwnDMList, createEoseSettler } from "../dmRelayListEnsure";
import { EVENT_KINDS } from "../../../types/nostr";
import { saveUserState } from "../../db/userStateStore";
import { BOOTSTRAP_RELAYS, APP_RELAY, INDEXER_RELAYS } from "../constants";
import { signAndPublish } from "../publish";
import { buildDMRelayListEvent } from "../eventBuilder";
import { subscribeUserData } from "./userData";
import type { LoginSignerType } from "./signerSession";

// The two relay-list bootstraps of a login: NIP-65 (kind:10002) and DM
// relays (kind:10050).

/** performLogin step 6: the relay-list (kind:10002) bootstrap. */
export function subscribeRelayList(pubkey: string): void {
  // Step 6: Subscribe for relay list (kind:10002). The NIP-65 indexers
  // (purplepag.es / user.kindpag.es) specialize in this kind — the
  // 10002-only filter is indexer-safe, so they aren't stripped.
  const relayListQueryUrls = [...INDEXER_RELAYS, ...BOOTSTRAP_RELAYS];
  let relayListEventArrived = false;
  let relayListQuerySettled = false;
  const relayListEosed = new Set<string>();
  // Runs once the query window closes (every queried relay EOSE'd, or the
  // timeout fired):
  // - no kind:10002 found anywhere → createdAt:1 sentinel ("checked relays,
  //   confirmed none" — same pattern as kind:3) so publishRelayList is
  //   unblocked for new users
  // - cached list but no fresh event → bootstrap pruning that step 5
  //   deliberately deferred while this query still needed bootstrap
  const settleRelayListQuery = () => {
    if (relayListQuerySettled) return;
    relayListQuerySettled = true;
    // Stale-login guard (#77): account switched mid-query — don't touch state.
    if (store.getState().identity.pubkey !== pubkey) return;
    const { relayList, relayListCreatedAt } = store.getState().identity;
    if (relayListCreatedAt === 0) {
      store.dispatch(setRelayList({ entries: relayList, createdAt: 1 }));
    }
    if (!relayListEventArrived && relayList.length > 0) {
      relayManager.reconcileUserRelays(relayList, { pruneBootstrap: true });
    }
  };
  const relayListSettleTimer = setTimeout(settleRelayListQuery, 10_000);
  relayManager.subscribe({
    filters: [{ kinds: [EVENT_KINDS.RELAY_LIST], authors: [pubkey], limit: 1 }],
    relayUrls: relayListQueryUrls,
    onEvent: (event) => {
      // Freshness: relays may serve stale 10002s (and this standing sub also
      // receives our own-publish echo). Skip anything NOT strictly newer than
      // what we already applied — `<=`, not `<`. The NIP-65 indexers + bootstrap
      // relays each echo the SAME kind:10002 (identical created_at) at cold
      // start; with `<` every one of those duplicates re-ran reconcile +
      // saveUserState + subscribeUserData, churning connections several times a
      // second. (The slice guard would reject the dispatch, but the side
      // effects below wouldn't know that.) See commit 8fcaf79.
      if (event.created_at <= store.getState().identity.relayListCreatedAt) return;
      const entries = parseRelayList(event);
      if (entries.length > 0) {
        relayListEventArrived = true;
        store.dispatch(setRelayList({ entries, createdAt: event.created_at }));
        saveUserState("relay_list", entries);
        // Connect the user's relays; the published list supersedes the
        // bootstrap defaults, so bootstrap relays not in it are pruned.
        relayManager.reconcileUserRelays(entries, { pruneBootstrap: true });
        // Re-subscribe for user data on user's own relays
        const userRelayUrls = entries
          .filter((e) => e.mode === "read" || e.mode === "read+write")
          .map((e) => e.url);
        if (userRelayUrls.length > 0) {
          subscribeUserData(pubkey, userRelayUrls);
        }
      }
    },
    onEOSE: (_subId, relayUrl) => {
      relayListEosed.add(relayUrl);
      if (relayListEosed.size >= relayListQueryUrls.length) {
        clearTimeout(relayListSettleTimer);
        settleRelayListQuery();
      }
    },
  });
}

/** performLogin step 6b: the DM-relay-list (kind:10050) bootstrap. */
export function subscribeDMRelayList(pubkey: string, signerType: LoginSignerType): void {
  // Step 6b: Subscribe for DM relay list (kind:10050) from bootstrap relays
  /** The newest list a relay served this session (not the IndexedDB cache). */
  let newestDMRelayList: { relays: string[]; createdAt: number } | null = null;
  // Act only once every bootstrap relay has EOSEd (or a grace after the first):
  // the first relay to answer may hold a stale list, and publishing a
  // "default" or an appended copy over a newer list we had not yet received
  // would overwrite the user's choice.
  const dmRelaySettler = createEoseSettler(BOOTSTRAP_RELAYS, () => {
    if (store.getState().identity.pubkey !== pubkey) return; // switched mid-login
    if (newestDMRelayList) {
      // A list exists: keep the platform relay in it (DM_WIRE_CONTRACT §1 —
      // append when missing, once a day, never after the user removed it).
      // Judged on the newest list a relay served, never on the cache alone.
      void ensureAppRelayInOwnDMList(pubkey, store.getState().identity.signerType, newestDMRelayList).catch(() => {});
      return;
    }
    // No kind:10050 found and no cache → auto-publish defaults
    const currentDMRelays = store.getState().identity.dmRelayList;
    // Don't auto-publish on a remote signer's behalf — it fires an unprompted
    // bunker approval at login. Bunker users can set DM relays manually.
    if (currentDMRelays.length === 0 && signerType !== "nip46") {
      const defaults = [APP_RELAY, "wss://relay.damus.io", "wss://nos.lol"];
      const unsigned = buildDMRelayListEvent(pubkey, defaults);
      signAndPublish(unsigned, BOOTSTRAP_RELAYS).then(() => {
        store.dispatch(setDMRelayList({ relays: defaults, createdAt: Math.floor(Date.now() / 1000) }));
        saveUserState("dm_relay_list", defaults);
      }).catch((err) => {
        console.error("[LoginFlow] Failed to auto-publish kind:10050:", err);
      });
    }
  });
  relayManager.subscribe({
    filters: [{ kinds: [10050], authors: [pubkey], limit: 1 }],
    relayUrls: BOOTSTRAP_RELAYS,
    onEvent: (event) => {
      const relays = parseDMRelayList(event);
      if (relays.length > 0) {
        if (!newestDMRelayList || event.created_at > newestDMRelayList.createdAt) {
          newestDMRelayList = { relays, createdAt: event.created_at };
        }
        store.dispatch(setDMRelayList({ relays, createdAt: event.created_at }));
        saveUserState("dm_relay_list", relays);
        // Connect to DM relays so gift wraps can be received
        for (const url of relays) {
          relayManager.connect(url);
        }
      }
    },
    onEOSE: (_subId, relayUrl) => dmRelaySettler.onEOSE(relayUrl),
  });
}
