import { store } from "../../store";
import {
  login,
  setProfile,
  markProfileChecked,
} from "../../store/slices/identitySlice";
import type { SignerType } from "../../store/slices/identitySlice";
import {
  clearRelayConnections,
} from "../../store/slices/relaysSlice";
import { relayManager } from "./relayManager";
import { subscriptionManager } from "./subscriptionManager";
import { clearDMRelayCache } from "./dmRelayList";
import { EVENT_KINDS } from "../../types/nostr";
import { saveUserState, getUserState } from "../db/userStateStore";
import { getProfile } from "../db/profileStore";
import { loadEnabledFeatures } from "../../features/settings/featuresPersistence";
import { setEnabledFeatures } from "../../store/slices/featuresSlice";
import { loadFeedPrefs } from "../../features/friends/feedPrefsPersistence";
import { setFeedPrefs } from "../../store/slices/feedPrefsSlice";
import { resetLibraryFill } from "../../features/music/libraryFill";
import {
  startMusicLibrarySync,
  drainMusicLibrarySync,
  flushMusicLibrarySync,
  cancelMusicLibrarySync,
} from "../../features/music/librarySync";
import { addNotification } from "../../store/slices/notificationSlice";
import { BOOTSTRAP_RELAYS, PROFILE_RELAYS } from "./constants";
import { profileCache } from "./profileCache";
import { loadDMState, startDMPersistence, cancelPendingSave as cancelDMSave, flushPendingSave as flushDMSave } from "../../features/dm/dmPersistence";
import { loadDMReadState, startDMReadStateSync, cancelPendingSave as cancelDMReadStateSave, flushPendingSave as flushDMReadStateSave } from "../../features/dm/dmReadState";
import { loadFollowerState, startFollowerPersistence, cancelPendingSave as cancelFollowerSave, flushPendingSave as flushFollowerSave } from "./followerPersistence";
import { loadFriendRequestState, startFriendRequestPersistence, cancelPendingSave as cancelFriendRequestSave, flushPendingSave as flushFriendRequestSave } from "./friendRequestPersistence";
import { loadNotificationState, startNotificationPersistence, cancelPendingSave as cancelNotificationSave, flushPendingSave as flushNotificationSave } from "../../features/notifications/notificationPersistence";
import { resetEventPipelineCaches } from "./eventPipeline";
import { verifyBridge } from "./verifyWorkerBridge";
import { startBackgroundChatSubs, stopAllBgChatSubs } from "./groupSubscriptions";
import { publishOutbox } from "./publishOutbox";
import { initLastChannelCache, clearLastChannelCache } from "../db/lastChannelCache";
import { clearAllUserState } from "../db/userStateStore";
import { resetAll } from "../../store";
import {
  setKnownFollowers,
  addKnownFollower,
  setAccounts,
  setSwitchingAccount,
  type AccountEntry,
} from "../../store/slices/identitySlice";
import { setActivePubkey, clearAccountState, migrateUnprefixedState } from "../db/userStateStore";
import { TauriSigner } from "./tauriSigner";
import { deleteSecret, nip46SecretKey, purgeWebSecrets } from "./secretStore";
import {
  restoreOnboardingState,
  setShowProfileWizard,
} from "../../features/onboarding/onboardingSlice";
import { loadOnboardingState } from "../../features/onboarding/onboardingPersistence";
import { createLogger, shortKey } from "../debug/logger";
import { clearProjectKeySession } from "../../features/music/sharedKey/projectKeys";
import { hydrateMediaPrefs, fetchMediaPrefs } from "../media/mediaPrefs";
import { ensureMediaGrant, clearMediaGrant } from "../media/mediaGrant";
import { musicTokenCache } from "../cache/tokenCache";
import { abandonMediaSessions } from "../webrtc/mediaSession";
import { endMediaSessionsForAccountChange } from "../../features/calling/accountChangeMedia";
import { loginState } from "./login/state";
import { subscribeGiftWraps } from "./login/giftWrapSub";
import { hydrateMusicFromCache, subscribeMusic } from "./login/music";
import { loadAndReconcileSpaces } from "./login/spaces";
import { subscribeRelayList, subscribeDMRelayList } from "./login/relayBootstrap";
import { ingestOwnProfileEvent, subscribeUserData, hydrateCachedUserLists } from "./login/userData";
import { wireRelayStatusBridge } from "./login/relayBridge";
import { getSigner, getSignerTimeoutMs, saveNip46Connection, loadNip46Connection, closeSignerIfRemote, createSessionSigner, type Nip46Connection } from "./login/signerSession";
export { getSigner, getSignerTimeoutMs };

const startupLog = createLogger("startup");
const idLog = createLogger("identity");

/** Dedup concurrent session restores. React StrictMode mounts AuthGate twice in
 *  dev, firing tryRestoreSession twice; without this guard two full logins race,
 *  doubling all subscriptions + IDB work. Concurrent callers share one promise. */
let restoreInFlight: Promise<boolean> | null = null;

/** Multi-account session format */
interface MultiAccountSession {
  accounts: AccountEntry[];
  activePubkey: string;
}

/** Legacy session format (pre-multi-account) */
interface LegacySession {
  pubkey: string;
  signerType: SignerType;
}

function isMultiAccountSession(s: unknown): s is MultiAccountSession {
  return !!s && typeof s === "object" && "accounts" in s && Array.isArray((s as MultiAccountSession).accounts);
}

/** performLogin step 7h: cached followers, then the live follower subscription. */
async function subscribeFollowers(pubkey: string): Promise<void> {
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

/** performLogin step 8: record this account in the multi-account session. */
async function persistSessionAccount(pubkey: string, storeSignerType: SignerType): Promise<void> {
  // Step 8: Persist multi-account session
  const existingSession = await getUserState<MultiAccountSession>("session");
  const accounts: AccountEntry[] = existingSession?.accounts ?? [];
  const existingIdx = accounts.findIndex((a) => a.pubkey === pubkey);
  const entry: AccountEntry = { pubkey, signerType: storeSignerType, addedAt: Date.now() };
  if (existingIdx >= 0) {
    accounts[existingIdx] = entry;
  } else {
    accounts.push(entry);
  }
  await saveUserState("session", { accounts, activePubkey: pubkey } satisfies MultiAccountSession);
  store.dispatch(setAccounts(accounts));
}

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
    const { getUserState } = await import("../db/userStateStore");
    const { restoreDeletedMessageIds } = await import("../../store/slices/eventsSlice");
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

/** Try to restore a previous session from IndexedDB. Re-entrant-safe: concurrent
 *  callers share one in-flight restore (see restoreInFlight). */
export function tryRestoreSession(): Promise<boolean> {
  if (restoreInFlight) {
    startupLog.debug("tryRestoreSession: already in flight — reusing existing restore");
    return restoreInFlight;
  }
  restoreInFlight = doRestoreSession().finally(() => {
    restoreInFlight = null;
  });
  return restoreInFlight;
}

async function doRestoreSession(): Promise<boolean> {
  const raw = await getUserState<MultiAccountSession | LegacySession>("session");
  if (!raw) return false;

  let pubkey: string;
  let signerType: SignerType;

  if (isMultiAccountSession(raw)) {
    // Multi-account format
    const active = raw.accounts.find((a) => a.pubkey === raw.activePubkey) ?? raw.accounts[0];
    if (!active) return false;
    pubkey = active.pubkey;
    signerType = active.signerType;
    // Sync accounts list to Redux
    store.dispatch(setAccounts(raw.accounts));
  } else {
    // Legacy format — migrate
    const legacy = raw as LegacySession;
    if (!legacy.pubkey || !legacy.signerType) return false;
    pubkey = legacy.pubkey;
    signerType = legacy.signerType;

    // Migrate session format
    const accounts: AccountEntry[] = [
      { pubkey, signerType, addedAt: Date.now() },
    ];
    await saveUserState("session", { accounts, activePubkey: pubkey } satisfies MultiAccountSession);
    store.dispatch(setAccounts(accounts));

    // Migrate un-prefixed IndexedDB keys to per-account
    setActivePubkey(pubkey);
    await migrateUnprefixedState(pubkey);
  }

  // Set active pubkey for IndexedDB key prefixing
  setActivePubkey(pubkey);

  const factoryType: "nip07" | "tauri" | "nip46" =
    signerType === "nip07" ? "nip07" : signerType === "nip46" ? "nip46" : "tauri";

  // Verify the signer is still available
  let nip46Connect: Nip46Connection | undefined;
  if (factoryType === "nip07") {
    if (typeof window === "undefined" || !("nostr" in window) || !window.nostr) {
      return false;
    }
  } else if (factoryType === "nip46") {
    // NIP-46 works in both web and desktop builds — gate on a stored connection.
    const conn = await loadNip46Connection(pubkey);
    if (!conn) return false;
    nip46Connect = conn;
  } else {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return false;
    }
  }

  try {
    await performLogin(factoryType, pubkey, nip46Connect);
    return true;
  } catch {
    if (factoryType === "nip46") {
      // Transient bunker offline — keep the account + secret, prompt to reconnect.
      store.dispatch(
        addNotification({
          id: `bunker-offline-${Date.now()}`,
          type: "chat",
          title: "Remote signer unavailable",
          body: "Couldn't reach your bunker. Reconnect when it's online.",
          timestamp: Date.now(),
        }),
      );
    }
    return false;
  }
}

/** Switch to a different stored account */
export async function switchAccount(targetPubkey: string): Promise<void> {
  const session = await getUserState<MultiAccountSession>("session");
  if (!session) throw new Error("No session found");
  const account = session.accounts.find((a) => a.pubkey === targetPubkey);
  if (!account) throw new Error("Account not found");

  // Prevent login screen flash during switch
  store.dispatch(setSwitchingAccount(true));

  try {
    // 0. End any call / voice channel while this account's signer is still
    //    the active one (hang up, clear presence; bounded). A call cannot
    //    move to another account — left running, it kept publishing as the
    //    old account with no UI to leave it.
    await endMediaSessionsForAccountChange();

    // 0b. Publish pending music library/folder edits while this account's
    //    signer is still the active one (bounded; cleanup can't do it).
    await drainMusicLibrarySync();

    // 1. Run cleanup (cancels timers, unsubs listeners, clears caches, disconnects relays)
    performCleanup();

    // 2. Switch keystore if Tauri account
    if (account.signerType === "tauri_keystore") {
      await TauriSigner.switchAccount(targetPubkey);
    }

    // 3. Set new activePubkey BEFORE resetAll so any IndexedDB reads during
    //    reset use the correct account prefix (not null/stale)
    setActivePubkey(targetPubkey);

    // 4. Reset Redux store AFTER activePubkey is set
    store.dispatch(resetAll());

    // 5. Update session
    session.activePubkey = targetPubkey;
    await saveUserState("session", session);

    // 6. Login as the new account
    const factoryType: "nip07" | "tauri" | "nip46" =
      account.signerType === "nip07"
        ? "nip07"
        : account.signerType === "nip46"
          ? "nip46"
          : "tauri";
    let nip46Connect: Nip46Connection | undefined;
    if (factoryType === "nip46") {
      nip46Connect = (await loadNip46Connection(targetPubkey)) ?? undefined;
      if (!nip46Connect) throw new Error("No saved bunker connection for this account.");
    }
    await performLogin(factoryType, targetPubkey, nip46Connect);
  } finally {
    store.dispatch(setSwitchingAccount(false));
  }
}

// ─── Adding an account (Add Account modal, Settings › Security › Import) ───
//
// Each of these makes ANOTHER key the active signer, so the current
// account's call is ended first, while its own signer can still sign the
// hang-up. (`TauriSigner.importKey` / `generateKey` switch the Rust-side
// active key immediately.)

export type AddAccountResult = { status: "already_active" } | { status: "added"; pubkey: string };

/**
 * Import an nsec / hex secret and make it the active account. Re-importing
 * the account that is already active changes nothing: no re-login, and an
 * ongoing call keeps running. Before this, it reset the app under a live call:
 * the meeting kept going but the UI said "join".
 */
export async function addAccountFromSecret(nsecOrHex: string): Promise<AddAccountResult> {
  // Validates the input and names the target without touching the keystore.
  const pubkey = await TauriSigner.pubkeyForSecret(nsecOrHex);
  if (pubkey === store.getState().identity.pubkey) return { status: "already_active" };

  await changeToNewAccount(async () => {
    await TauriSigner.importKey(nsecOrHex);
    performCleanup();
    store.dispatch(resetAll());
    await performLogin("tauri", pubkey);
  });
  return { status: "added", pubkey };
}

/** Generate a brand-new key and make it the active account. */
export async function addGeneratedAccount(): Promise<void> {
  await changeToNewAccount(async () => {
    const pubkey = await TauriSigner.generateKey();
    performCleanup();
    store.dispatch(resetAll());
    await performLogin("tauri", pubkey);
  });
}

/** Connect a NIP-46 bunker and make it the active account. */
export async function addBunkerAccount(bunkerUri: string, clientSecretHex: string): Promise<void> {
  await changeToNewAccount(async () => {
    performCleanup();
    store.dispatch(resetAll());
    await performLogin("nip46", undefined, { bunkerUri, clientSecretHex });
  });
}

/** Shared frame: loading screen up, current account's call ended while its
 *  signer is still active, then `login` (which swaps the signer). */
async function changeToNewAccount(login: () => Promise<void>): Promise<void> {
  store.dispatch(setSwitchingAccount(true));
  try {
    await endMediaSessionsForAccountChange();
    await login();
  } finally {
    store.dispatch(setSwitchingAccount(false));
  }
}

/** Remove a specific account. If it's the last one, full logout. */
export async function removeAccount(pubkeyToRemove: string): Promise<void> {
  const session = await getUserState<MultiAccountSession>("session");
  if (!session) return;

  const remaining = session.accounts.filter((a) => a.pubkey !== pubkeyToRemove);

  // Removing the active account: end its call before its key is deleted
  // below; afterwards nothing could sign the hang-up.
  if (store.getState().identity.pubkey === pubkeyToRemove) {
    await endMediaSessionsForAccountChange();
  }

  // Clear the removed account's IndexedDB data
  await clearAccountState(pubkeyToRemove);

  // Delete the keystore key if Tauri
  const account = session.accounts.find((a) => a.pubkey === pubkeyToRemove);
  if (account?.signerType === "tauri_keystore") {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("keystore_delete_key", { pubkey: pubkeyToRemove });
    } catch {
      // Key may already be deleted
    }
  } else if (account?.signerType === "nip46") {
    // Ephemeral key is disposable — delete the stored bunker connection.
    await deleteSecret(nip46SecretKey(pubkeyToRemove)).catch(() => {});
  }

  if (remaining.length === 0) {
    // Last account — full logout
    await performLogout();
    return;
  }

  // Switch to another account
  session.accounts = remaining;
  if (session.activePubkey === pubkeyToRemove) {
    session.activePubkey = remaining[0].pubkey;
  }
  await saveUserState("session", session);

  // If we removed the active account, switch
  if (store.getState().identity.pubkey === pubkeyToRemove) {
    await switchAccount(remaining[0].pubkey);
  } else {
    // Just update the accounts list
    store.dispatch(setAccounts(remaining));
  }
}

/** Internal cleanup: everything performLogout does except clearing session.
 *  Does NOT reset Redux or set activePubkey — caller controls ordering. */
export function performCleanup(): void {
  // 0. Backstop: no call or voice room outlives its account. Callers end
  //    them gracefully first (endMediaSessionsForAccountChange); this hard
  //    stop covers any path that didn't. Signs nothing.
  void abandonMediaSessions();

  // 1. FLUSH pending saves while activePubkey still points to the old account.
  //    This persists read state, DM state, etc. so they survive the switch.
  flushDMSave();
  flushDMReadStateSave();
  flushFollowerSave();
  flushFriendRequestSave();
  flushNotificationSave();
  flushMusicLibrarySync();

  // 2. Unsubscribe persistence listeners
  loginState.cleanupDMPersistence?.();
  loginState.cleanupDMPersistence = null;
  loginState.cleanupDMReadState?.();
  loginState.cleanupDMReadState = null;
  loginState.cleanupFollowerPersistence?.();
  loginState.cleanupFollowerPersistence = null;
  loginState.cleanupFriendRequestPersistence?.();
  loginState.cleanupFriendRequestPersistence = null;
  loginState.cleanupNotificationPersistence?.();
  loginState.cleanupNotificationPersistence = null;
  loginState.cleanupMusicLibrarySync?.();
  loginState.cleanupMusicLibrarySync = null;
  resetLibraryFill();

  loginState.cleanupActiveSpacePersistence?.();
  loginState.cleanupActiveSpacePersistence = null;
  loginState.cleanupGiftWrapReconciliation?.();
  loginState.cleanupGiftWrapReconciliation = null;
  loginState.cleanupProjectKeyListener?.();
  loginState.cleanupProjectKeyListener = null;
  clearProjectKeySession();

  // 3. Close subscriptions and background chat subs
  subscriptionManager.closeAll();
  stopAllBgChatSubs();

  // 4. Clear module-level caches (signer, profile, DM relay, channel, dedup, authorSet)
  closeSignerIfRemote(loginState.currentSigner);
  loginState.currentSigner = null;
  profileCache.clear();
  clearDMRelayCache();
  clearLastChannelCache();
  resetEventPipelineCaches();
  verifyBridge.drainPending();
  // Media access is per account: the viewer grant and music track grants.
  clearMediaGrant();
  musicTokenCache.clear();

  // 5. Disconnect relays. disconnectAll() reports nothing per relay (that was
  //    two store updates per connection inside the switch); one action clears
  //    the connection rows instead.
  relayManager.disconnectAll();
  store.dispatch(clearRelayConnections());
}

/** Full logout: stop listeners, close subscriptions, clear caches, reset store */
export async function performLogout(): Promise<void> {
  // 0. End any call / voice channel while the signer is still active.
  await endMediaSessionsForAccountChange();

  // 0b. Publish pending music library/folder edits while the signer is still
  //    active (bounded): the local rows are wiped below, so anything still
  //    unsent would otherwise be lost for good.
  await drainMusicLibrarySync();

  // 1. Cancel pending debounce timers FIRST to prevent stale writes
  cancelDMSave();
  cancelDMReadStateSave();
  cancelFollowerSave();
  cancelFriendRequestSave();
  cancelNotificationSave();
  cancelMusicLibrarySync();

  // 2. Stop persistence listeners
  loginState.cleanupDMPersistence?.();
  loginState.cleanupDMPersistence = null;
  loginState.cleanupDMReadState?.();
  loginState.cleanupDMReadState = null;
  loginState.cleanupFollowerPersistence?.();
  loginState.cleanupFollowerPersistence = null;
  loginState.cleanupFriendRequestPersistence?.();
  loginState.cleanupFriendRequestPersistence = null;
  loginState.cleanupNotificationPersistence?.();
  loginState.cleanupNotificationPersistence = null;
  loginState.cleanupMusicLibrarySync?.();
  loginState.cleanupMusicLibrarySync = null;
  resetLibraryFill();
  loginState.cleanupActiveSpacePersistence?.();
  loginState.cleanupActiveSpacePersistence = null;
  loginState.cleanupGiftWrapReconciliation?.();
  loginState.cleanupGiftWrapReconciliation = null;
  loginState.cleanupProjectKeyListener?.();
  loginState.cleanupProjectKeyListener = null;
  clearProjectKeySession();

  // 3. Close all relay subscriptions and background chat subs
  subscriptionManager.closeAll();
  stopAllBgChatSubs();

  // 4. Clear signer and module-level caches
  closeSignerIfRemote(loginState.currentSigner);
  loginState.currentSigner = null;
  profileCache.clear();
  clearDMRelayCache();
  clearLastChannelCache();
  resetEventPipelineCaches();
  verifyBridge.drainPending();
  clearMediaGrant();
  musicTokenCache.clear();
  setActivePubkey(null);

  // 5. Disconnect relays (and hard-stop any room the graceful step missed)
  void abandonMediaSessions();
  relayManager.disconnectAll();
  store.dispatch(clearRelayConnections());

  // 6. Clear keystore active pubkey (so next login generates fresh)
  try {
    await TauriSigner.clearActive();
  } catch {
    // Not in Tauri environment, or keystore unavailable
  }

  // 6.5 Web builds: purge transport secrets (LLM/web-search keys, bunker/NWC
  // URIs) from session memory AND any opted-in localStorage entries — they must
  // not survive logout (audit #95). No-op on Tauri (keychain is by-design
  // persistent across logins).
  purgeWebSecrets();

  // 7. Clear IndexedDB — AWAIT so data is gone before next login
  await Promise.all([
    clearAllUserState().catch(() => {}),
  ]);

  // 8. Reset entire Redux store (all 17+ slices → initialState)
  store.dispatch(resetAll());
}
