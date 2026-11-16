import { store } from "../../../store";
import type { SignerType } from "../../../store/slices/identitySlice";
import { saveUserState, getUserState } from "../../db/userStateStore";
import { addNotification } from "../../../store/slices/notificationSlice";
import {
  setAccounts,
  type AccountEntry,
} from "../../../store/slices/identitySlice";
import { setActivePubkey, migrateUnprefixedState } from "../../db/userStateStore";
import { createLogger } from "../../debug/logger";
import { performLogin } from "./performLogin";
import { loadNip46Connection, type Nip46Connection } from "./signerSession";
import { isMultiAccountSession, type MultiAccountSession, type LegacySession } from "./sessionStore";

// Session restore at app start.

const startupLog = createLogger("startup");

/** Dedup concurrent session restores. React StrictMode mounts AuthGate twice in
 *  dev, firing tryRestoreSession twice; without this guard two full logins race,
 *  doubling all subscriptions + IDB work. Concurrent callers share one promise. */
let restoreInFlight: Promise<boolean> | null = null;

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
