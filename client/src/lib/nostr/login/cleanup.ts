import { store } from "../../../store";
import {
  clearRelayConnections,
} from "../../../store/slices/relaysSlice";
import { relayManager } from "../relayManager";
import { subscriptionManager } from "../subscriptionManager";
import { clearDMRelayCache } from "../dmRelayList";
import { resetLibraryFill } from "../../../features/music/libraryFill";
import {
  drainMusicLibrarySync,
  flushMusicLibrarySync,
  cancelMusicLibrarySync,
} from "../../../features/music/librarySync";
import { profileCache } from "../profileCache";
import { cancelPendingSave as cancelDMSave, flushPendingSave as flushDMSave } from "../../../features/dm/dmPersistence";
import { cancelPendingSave as cancelDMReadStateSave, flushPendingSave as flushDMReadStateSave } from "../../../features/dm/dmReadState";
import { cancelPendingSave as cancelFollowerSave, flushPendingSave as flushFollowerSave } from "../followerPersistence";
import { cancelPendingSave as cancelFriendRequestSave, flushPendingSave as flushFriendRequestSave } from "../friendRequestPersistence";
import { cancelPendingSave as cancelNotificationSave, flushPendingSave as flushNotificationSave } from "../../../features/notifications/notificationPersistence";
import { resetEventPipelineCaches } from "../eventPipeline";
import { verifyBridge } from "../verifyWorkerBridge";
import { stopAllBgChatSubs } from "../groupSubscriptions";
import { clearLastChannelCache } from "../../db/lastChannelCache";
import { clearAllUserState } from "../../db/userStateStore";
import { resetAll } from "../../../store";
import { setActivePubkey } from "../../db/userStateStore";
import { TauriSigner } from "../tauriSigner";
import { purgeWebSecrets } from "../secretStore";
import { clearProjectKeySession } from "../../../features/music/sharedKey/projectKeys";
import { clearMediaGrant } from "../../media/mediaGrant";
import { musicTokenCache } from "../../cache/tokenCache";
import { abandonMediaSessions } from "../../webrtc/mediaSession";
import { endMediaSessionsForAccountChange } from "../../../features/calling/accountChangeMedia";
import { loginState } from "./state";
import { closeSignerIfRemote } from "./signerSession";

// Teardown: performCleanup (account switch) and performLogout. The order of
// the steps in each is load-bearing; see the numbered comments.

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
