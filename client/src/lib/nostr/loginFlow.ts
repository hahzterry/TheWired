/**
 * Login flow: entry point.
 *
 * The login path lives in `./login/`:
 *   performLogin.ts    the session bootstrap: the order of a login, step by step
 *   signerSession.ts   the active signer (getSigner), its timeout, the saved bunker connection
 *   restore.ts         tryRestoreSession (app start)
 *   accounts.ts        switchAccount, add (import / generate / bunker), removeAccount
 *   cleanup.ts         performCleanup (account switch) and performLogout: the teardown order
 *   state.ts           the one object holding the signer and the listener cleanup handles
 *   sessionStore.ts    the persisted multi-account session
 *   relayBridge.ts     relay manager → store
 *   userData.ts        own profile / follows / mutes / pins, cached lists
 *   relayBootstrap.ts  kind:10002 and kind:10050 bootstraps
 *   spaces.ts          joined spaces: cache, backend recovery, reconcile
 *   music.ts           music from IndexedDB, music subscriptions
 *   giftWrapSub.ts     kind:1059 inbox subscription     followers.ts  follower subscription
 *
 * Import from this file, not from `./login/*`.
 */
import "./login/evaluationOrder";

export { getSigner, getSignerTimeoutMs } from "./login/signerSession";
export { performLogin } from "./login/performLogin";
export { tryRestoreSession } from "./login/restore";
export {
  switchAccount,
  addAccountFromSecret,
  addGeneratedAccount,
  addBunkerAccount,
  removeAccount,
} from "./login/accounts";
export type { AddAccountResult } from "./login/accounts";
export { performCleanup, performLogout } from "./login/cleanup";
