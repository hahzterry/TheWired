import { store } from "../../../store";
import {
  login,
  setProfile,
  markProfileChecked,
} from "../../../store/slices/identitySlice";
import type { SignerType } from "../../../store/slices/identitySlice";
import { relayManager } from "../relayManager";
import { EVENT_KINDS } from "../../../types/nostr";
import { saveUserState } from "../../db/userStateStore";
import { getProfile } from "../../db/profileStore";
import { loadEnabledFeatures } from "../../../features/settings/featuresPersistence";
import { setEnabledFeatures } from "../../../store/slices/featuresSlice";
import { loadFeedPrefs } from "../../../features/friends/feedPrefsPersistence";
import { setFeedPrefs } from "../../../store/slices/feedPrefsSlice";
import {
  startMusicLibrarySync,
} from "../../../features/music/librarySync";
import { BOOTSTRAP_RELAYS, PROFILE_RELAYS } from "../constants";
import { loadDMState, startDMPersistence } from "../../../features/dm/dmPersistence";
import { loadDMReadState, startDMReadStateSync } from "../../../features/dm/dmReadState";
import { loadFriendRequestState, startFriendRequestPersistence } from "../friendRequestPersistence";
import { loadNotificationState, startNotificationPersistence } from "../../../features/notifications/notificationPersistence";
import { startBackgroundChatSubs } from "../groupSubscriptions";
import { publishOutbox } from "../publishOutbox";
import { initLastChannelCache } from "../../db/lastChannelCache";
import { setActivePubkey } from "../../db/userStateStore";
import {
  restoreOnboardingState,
  setShowProfileWizard,
} from "../../../features/onboarding/onboardingSlice";
import { loadOnboardingState } from "../../../features/onboarding/onboardingPersistence";
import { createLogger, shortKey } from "../../debug/logger";
import { hydrateMediaPrefs, fetchMediaPrefs } from "../../media/mediaPrefs";
import { ensureMediaGrant } from "../../media/mediaGrant";
import { loginState } from "./state";
import { createSessionSigner, saveNip46Connection, type Nip46Connection } from "./signerSession";
import { wireRelayStatusBridge } from "./relayBridge";
import { ingestOwnProfileEvent, subscribeUserData, hydrateCachedUserLists } from "./userData";
import { subscribeRelayList, subscribeDMRelayList } from "./relayBootstrap";
import { loadAndReconcileSpaces } from "./spaces";
import { hydrateMusicFromCache, subscribeMusic } from "./music";
import { subscribeGiftWraps } from "./giftWrapSub";
import { subscribeFollowers } from "./followers";
import { persistSessionAccount } from "./sessionStore";

// performLogin: the session bootstrap. This file is the order of a login;
// each step's work lives in the module it is imported from.

const startupLog = createLogger("startup");
const idLog = createLogger("identity");

/**
 * Full login flow.
 * @param signerTypeOverride - force a specific signer type
 * @param knownPubkey - skip getPublicKey() call if we already know the pubkey
 *                      (avoids extra keychain reads on macOS)
 */
export async function performLogin(
  signerTypeOverride?: "nip07" | "tauri" | "nip46",
  knownPubkey?: string,
  nip46Connect?: Nip46Connection,
): Promise<void> {
  loginState.loginStartedAt = performance.now();
  startupLog.info(
    `performLogin start (signerType=${signerTypeOverride ?? "auto"}, knownPubkey=${knownPubkey ? shortKey(knownPubkey) : "none"})`,
  );

  // Step 1: Wire relay → Redux status bridge
  wireRelayStatusBridge();

  // Step 2: Connect to bootstrap relays and WAIT for at least one
  await relayManager.connectToBootstrapAndWait();
  startupLog.info(`bootstrap relays ready after ${(performance.now() - loginState.loginStartedAt).toFixed(0)}ms`);

  // Step 3: Detect/create signer and get pubkey
  const { signerType, pubkey } = await createSessionSigner(signerTypeOverride, knownPubkey, nip46Connect);

  // Set active pubkey for per-account IndexedDB key prefixing
  setActivePubkey(pubkey);

  // Step 4: Dispatch login to Redux
  const storeSignerType: SignerType =
    signerType === "nip07"
      ? "nip07"
      : signerType === "nip46"
        ? "nip46"
        : "tauri_keystore";
  store.dispatch(login({ pubkey, signerType: storeSignerType }));

  // Fix #5: hydrate the logged-in user's own profile from IndexedDB immediately,
  // so their name (ProfileCard, composer, etc.) renders instead of a hash while the
  // kind:0 relay subscription below is still in flight. `identity.profile` was
  // previously ONLY ever set from that relay event — never from cache — so on every
  // cold start the user's own name was a hash for as long as the relay round-trip took
  // (worse in prod, where there's no local relay). createdAt comes from the stored
  // event, so a fresher relay kind:0 still wins via setProfile's freshness guard.
  getProfile(pubkey)
    .then((stored) => {
      if (!stored) {
        idLog.debug(`own profile not in IDB cache — name shows hash until own kind:0 arrives`);
        return;
      }
      if (store.getState().identity.profile) return; // relay already populated it
      idLog.info(
        `hydrated own profile from IDB → "${stored.display_name || stored.name || "unnamed"}" (instant, before relay round-trip)`,
      );
      store.dispatch(setProfile({ profile: stored, createdAt: stored.created_at ?? 0 }));
    })
    .catch(() => {/* best-effort */});

  // Persist the bunker connection (ephemeral key + URI) so we can reconnect on restart.
  if (signerType === "nip46" && nip46Connect) {
    await saveNip46Connection(pubkey, nip46Connect);
  }

  // Replay NIP-42 AUTH on any relay that connected (and challenged) before the
  // signer was ready. Without this, a relay connection established pre-login
  // stays unauthenticated forever — which silently filters out every h-tagged
  // event (NIP-29 chat) on both query and broadcast paths.
  relayManager.replayAuth();

  // Step 5 (5–5e): cached relay, DM relay, follow, pin and mute lists
  await hydrateCachedUserLists();

  // Step 6: relay list (kind:10002)
  subscribeRelayList(pubkey);

  // Step 6b: DM relay list (kind:10050)
  subscribeDMRelayList(pubkey, signerType);

  // Step 7: Subscribe for user metadata from bootstrap relays
  subscribeUserData(pubkey, BOOTSTRAP_RELAYS);

  // Step 7-a: Also fetch our OWN kind:0 from the profile indexers. subscribeUserData
  // bundles kinds 0/3/10000/10003, which makes relayManager strip the indexer-only
  // relays (purplepag.es / kindpag.es) from that sub — so our own profile would only
  // ever come from bootstrap + the user's relays, resolving LESS reliably than a
  // stranger's (which goes through PROFILE_RELAYS). A kind:0-only filter is
  // indexer-safe, so this reaches the indexers where most clients aggregate kind:0.
  relayManager.subscribe({
    filters: [{ kinds: [EVENT_KINDS.METADATA], authors: [pubkey], limit: 1 }],
    relayUrls: PROFILE_RELAYS,
    onEvent: (event) => ingestOwnProfileEvent(event, pubkey),
    onEOSE: () => store.dispatch(markProfileChecked()),
  });

  // Step 7b: Load spaces + last-channel cache from IndexedDB
  await initLastChannelCache();
  // Hydrate the per-account feature toggles (e.g. Decentralized Spaces) so any
  // UI gated on them renders correctly from the first paint.
  store.dispatch(setEnabledFeatures(await loadEnabledFeatures()));
  // Hydrate the per-account Feed preferences (toggles + local hidden accounts).
  store.dispatch(setFeedPrefs(await loadFeedPrefs()));
  // Media storage prefs (docs/MEDIA_STORAGE.md §2): the cached copy now, the
  // relay doc in the background. Uploads use the defaults (The Wired only)
  // until either lands. The viewer's media grant is minted alongside so
  // members-only space media renders without a first 404.
  await hydrateMediaPrefs();
  void fetchMediaPrefs();
  void ensureMediaGrant();

  // Step 7b (continued): the joined spaces
  const savedSpaces = await loadAndReconcileSpaces();

  // Step 7c + 7d: music events and the music library, from IndexedDB
  await hydrateMusicFromCache(pubkey);

  // Step 7d-b: Load notification state BEFORE relay subscriptions so that
  // re-delivered events (which trigger evaluateCollaboratorNotification)
  // find existing notifications and skip them via addNotification dedup.
  await loadNotificationState();
  loginState.cleanupNotificationPersistence = startNotificationPersistence();

  // Step 7e: music subscriptions (own, tagged, shared-project) and library refills
  subscribeMusic(pubkey);

  // Step 7e-b: Load persisted deleted message IDs from IndexedDB
  {
    const { getUserState } = await import("../../db/userStateStore");
    const { restoreDeletedMessageIds } = await import("../../../store/slices/eventsSlice");
    const deletedIds = await getUserState<Record<string, true>>("deletedMessageIds");
    if (deletedIds) {
      store.dispatch(restoreDeletedMessageIds(deletedIds));
    }
  }

  // Step 7f: Load persisted DMs from IndexedDB BEFORE subscribing to relays.
  // This populates processedWrapIds so relay echoes are deduped and
  // messages keep their original display timestamps.
  await loadDMState();
  loginState.cleanupDMPersistence = startDMPersistence();

  // Step 7f-a: Fetch relay-synced DM read state (NIP-78).
  // This populates lastReadTimestamps so re-fetched DMs after a cache clear
  // are correctly marked as already-read.
  loadDMReadState();
  loginState.cleanupDMReadState = startDMReadStateSync();

  // Step 7f-a2: Music library + folders sync with the account's other
  // devices (encrypted kind-30078 docs). After the DM bootstrap so a remote
  // signer serves DM unwraps first.
  loginState.cleanupMusicLibrarySync?.();
  loginState.cleanupMusicLibrarySync = startMusicLibrarySync(pubkey);

  // Step 7f-b: Load persisted friend requests from IndexedDB
  await loadFriendRequestState();
  loginState.cleanupFriendRequestPersistence = startFriendRequestPersistence();

  // Step 7f-c: Notification state already loaded in step 7d-b (before relay subs).

  // Step 7f-d: NOW start background chat subs — notification state is restored,
  // so re-fetched messages will be correctly filtered by lastReadTimestamps.
  if (savedSpaces.length > 0) {
    startBackgroundChatSubs(savedSpaces);
  }

  // Replay any publishes left un-acked from a previous session (relay drop /
  // hard refresh / crash). Background + <24h, drops stale replaceables (#34).
  void publishOutbox.replay();

  // Persist active space changes to IndexedDB for restore on next login/switch
  {
    let lastSpaceId = store.getState().spaces.activeSpaceId;
    loginState.cleanupActiveSpacePersistence = store.subscribe(() => {
      const current = store.getState().spaces.activeSpaceId;
      if (current !== lastSpaceId) {
        lastSpaceId = current;
        if (current) {
          saveUserState("active_space", current).catch(() => {});
        }
      }
    });
  }

  // Step 7g: gift-wrapped DMs (kind:1059)
  await subscribeGiftWraps(pubkey);

  // Step 7h: followers
  await subscribeFollowers(pubkey);

  // Step 8: Persist multi-account session
  await persistSessionAccount(pubkey, storeSignerType);

  // Step 9: Check onboarding state and trigger wizard for new users
  const onboardingState = await loadOnboardingState();
  store.dispatch(restoreOnboardingState(onboardingState));
  if (!onboardingState?.profileWizardCompleted) {
    store.dispatch(setShowProfileWizard(true));
  }
}
