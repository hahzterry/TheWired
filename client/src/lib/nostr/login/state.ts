import type { NostrSigner } from "../signer";

/**
 * Module-level state of the login path. There is exactly one: every file in
 * `login/` reads and writes this object, the way `loginFlow.ts` read and
 * wrote its own top-level variables before it was split.
 */
export const loginState = {
  /** Set at the start of performLogin so subscribeUserData can report own-profile latency. */
  loginStartedAt: 0,

  currentSigner: null as NostrSigner | null,

  /** Persistence listener cleanup functions — captured so we can stop them on logout */
  cleanupDMPersistence: null as (() => void) | null,
  cleanupDMReadState: null as (() => void) | null,
  cleanupFollowerPersistence: null as (() => void) | null,
  cleanupFriendRequestPersistence: null as (() => void) | null,
  cleanupNotificationPersistence: null as (() => void) | null,
  cleanupMusicLibrarySync: null as (() => void) | null,
  cleanupActiveSpacePersistence: null as (() => void) | null,
  cleanupGiftWrapReconciliation: null as (() => void) | null,
  cleanupProjectKeyListener: null as (() => void) | null,
};
