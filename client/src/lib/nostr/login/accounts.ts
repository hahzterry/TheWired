import { store } from "../../../store";
import { saveUserState, getUserState } from "../../db/userStateStore";
import {
  drainMusicLibrarySync,
} from "../../../features/music/librarySync";
import { resetAll } from "../../../store";
import {
  setAccounts,
  setSwitchingAccount,
} from "../../../store/slices/identitySlice";
import { setActivePubkey, clearAccountState } from "../../db/userStateStore";
import { TauriSigner } from "../tauriSigner";
import { deleteSecret, nip46SecretKey } from "../secretStore";
import { endMediaSessionsForAccountChange } from "../../../features/calling/accountChangeMedia";
import { performLogin } from "./performLogin";
import { performCleanup, performLogout } from "./cleanup";
import { loadNip46Connection, type Nip46Connection } from "./signerSession";
import type { MultiAccountSession } from "./sessionStore";

// Accounts: switching, adding (import / generate / bunker) and removing.

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
