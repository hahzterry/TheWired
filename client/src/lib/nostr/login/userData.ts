import { store } from "../../../store";
import {
  setProfile,
  markProfileChecked,
  setRelayList,
  setDMRelayList,
  setFollowList,
  setMuteList,
  setPinnedNotes,
} from "../../../store/slices/identitySlice";
import type { MuteEntry } from "../../../store/slices/identitySlice";
import type { RelayListEntry } from "../../../types/relay";
import { relayManager } from "../relayManager";
import { loadAndApplyDisabledRelays } from "../relayList";
import { EVENT_KINDS } from "../../../types/nostr";
import { saveUserState, getUserState } from "../../db/userStateStore";
import { notePinListSeen } from "../../../features/profile/pinListWrite";
import { pinnedIdsFromTags } from "../../../features/profile/pinList";
import { profileCache } from "../profileCache";
import { parseProfile } from "../../../features/profile/profileParser";
import { createLogger } from "../../debug/logger";
import { loginState } from "./state";

// The logged-in user's own data: profile, follows, mutes and pins from
// relays, and the cached copies hydrated at login.

const idLog = createLogger("identity");

/** Mute tag name → MuteEntry type */
const MUTE_TAG_MAP: Record<string, "pubkey" | "tag" | "word" | "event"> = {
  p: "pubkey",
  t: "tag",
  word: "word",
  e: "event",
};

/** Ingest the logged-in user's own kind:0 from any subscription: parse it (which
 *  preserves fields we don't model, e.g. lud06), reconcile through the freshness
 *  guard, and keep the shared profile cache in sync. */
export function ingestOwnProfileEvent(event: import("../../../types/nostr").NostrEvent, pubkey: string): void {
  if (event.pubkey !== pubkey || event.kind !== EVENT_KINDS.METADATA) return;
  const profile = parseProfile(event);
  if (!profile) {
    idLog.warn(`own kind:0 had invalid JSON content — profile not updated`);
    return;
  }
  const latency = loginState.loginStartedAt ? `${(performance.now() - loginState.loginStartedAt).toFixed(0)}ms after login` : "";
  idLog.info(
    `own kind:0 received → "${profile.display_name || profile.name || "unnamed"}" ${latency} — dispatching to identity slice`,
  );
  store.dispatch(setProfile({ profile, createdAt: event.created_at }));
  profileCache.handleProfileEvent(event);
}

/** Subscribe for user metadata (profile, follows, mutes) on given relays */
export function subscribeUserData(
  pubkey: string,
  relayUrls?: string[],
): string {
  return relayManager.subscribe({
    filters: [
      { kinds: [EVENT_KINDS.METADATA], authors: [pubkey], limit: 1 },
      { kinds: [EVENT_KINDS.FOLLOW_LIST], authors: [pubkey], limit: 1 },
      { kinds: [EVENT_KINDS.MUTE_LIST], authors: [pubkey], limit: 1 },
      { kinds: [EVENT_KINDS.PINNED_NOTES], authors: [pubkey], limit: 1 },
    ],
    relayUrls,
    onEvent: (event) => {
      // Guard: only process events from the logged-in user
      if (event.pubkey !== pubkey) return;

      switch (event.kind) {
        case EVENT_KINDS.METADATA: {
          ingestOwnProfileEvent(event, pubkey);
          break;
        }
        case EVENT_KINDS.FOLLOW_LIST: {
          const follows = event.tags
            .filter((t) => t[0] === "p" && t[1])
            .map((t) => t[1]);
          store.dispatch(setFollowList({ follows, createdAt: event.created_at }));
          saveUserState("follow_list", follows);
          break;
        }
        case EVENT_KINDS.MUTE_LIST: {
          const mutes = event.tags
            .filter((t) => t[0] in MUTE_TAG_MAP && t[1])
            .map((t) => ({
              type: MUTE_TAG_MAP[t[0]],
              value: t[1],
            }));
          store.dispatch(setMuteList({ mutes, createdAt: event.created_at }));
          saveUserState("mute_list", mutes);
          break;
        }
        case EVENT_KINDS.PINNED_NOTES: {
          // Verified and remembered as a base for pin writes (pinListWrite):
          // a write whose own read misses this copy still builds on it.
          if (!notePinListSeen(event, pubkey)) break;
          const noteIds = pinnedIdsFromTags(event.tags);
          store.dispatch(setPinnedNotes({ noteIds, createdAt: event.created_at }));
          saveUserState("pinned_notes", noteIds);
          break;
        }
      }
    },
    onEOSE: () => {
      // We've heard back from the relays — whether or not a kind:0 was found, the
      // profile editors can now safely build a republish (no real profile to clobber).
      store.dispatch(markProfileChecked());
      // If no kind:3 was found on relays (new user or contact list not on these
      // relays), mark the follow list as loaded so follow actions aren't blocked.
      // createdAt: 1 is a sentinel meaning "checked relays, confirmed empty" —
      // any real kind:3 event will have a much larger timestamp and override this.
      const { followListCreatedAt } = store.getState().identity;
      if (followListCreatedAt === 0) {
        store.dispatch(setFollowList({ follows: [], createdAt: 1 }));
      }
    },
  });
}

/** performLogin step 5: the account's cached lists, from IndexedDB, for instant UI. */
export async function hydrateCachedUserLists(): Promise<void> {
  // Step 5: Load cached user data from IndexedDB for instant UI
  // Disabled relays first, so the cached-list connect below never dials them.
  await loadAndApplyDisabledRelays();
  const cachedRelayList = await getUserState<RelayListEntry[]>("relay_list");
  if (cachedRelayList) {
    // createdAt: 0 so relay data always wins
    store.dispatch(setRelayList({ entries: cachedRelayList, createdAt: 0 }));
    // No bootstrap pruning yet — the kind:10002 query (step 6) still needs
    // bootstrap; pruning happens once that query resolves.
    relayManager.reconcileUserRelays(cachedRelayList, { pruneBootstrap: false });
  }

  // Step 5b: Load cached DM relay list from IndexedDB
  const cachedDMRelays = await getUserState<string[]>("dm_relay_list");
  if (cachedDMRelays?.length) {
    store.dispatch(setDMRelayList({ relays: cachedDMRelays, createdAt: 0 }));
    // Pre-connect cached DM relays so gift wrap subscription can reach them
    for (const url of cachedDMRelays) {
      relayManager.connect(url);
    }
  }

  // Step 5c: Load cached follow list from IndexedDB
  // CRITICAL: without this, followList starts as [] after login/reset, and any
  // follow action (manual or auto-follow from friend accept) would publish a
  // kind:3 containing only the new follow — nuking the real contact list.
  const cachedFollowList = await getUserState<string[]>("follow_list");
  if (cachedFollowList?.length) {
    store.dispatch(setFollowList({ follows: cachedFollowList, createdAt: 0 }));
  }

  // Step 5d: Load cached pinned notes from IndexedDB
  const cachedPinnedNotes = await getUserState<string[]>("pinned_notes");
  if (cachedPinnedNotes?.length) {
    store.dispatch(setPinnedNotes({ noteIds: cachedPinnedNotes, createdAt: 0 }));
  }

  // Step 5e: Load cached mute list from IndexedDB
  // Same wipe-guard rationale as the follow list (5c): without this, muteList
  // starts as [] after login/reset, and an early mute or muted-word edit would
  // publish a kind:10000 missing every previously muted entry.
  // createdAt: 0 so the relay copy always wins.
  const cachedMuteList = await getUserState<MuteEntry[]>("mute_list");
  if (cachedMuteList?.length) {
    store.dispatch(setMuteList({ mutes: cachedMuteList, createdAt: 0 }));
  }
}
