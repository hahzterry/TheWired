import { store } from "../../../store";
import { detectSigner, createSigner, type NostrSigner } from "../signer";
import { bunkerAuthUrlOrNull } from "../nip46AuthUrl";
import { addNotification } from "../../../store/slices/notificationSlice";
import { TauriSigner } from "../tauriSigner";
import { setSecret, getSecret, nip46SecretKey } from "../secretStore";
import { loginState } from "./state";

// The session's signer: the active signer and its timeout budget, the saved
// NIP-46 bunker connection, and building the signer at login.

export function getSigner(): NostrSigner | null {
  return loginState.currentSigner;
}

/** Signing timeout budget. NIP-46 bunkers may require manual approval, so give them longer. */
export function getSignerTimeoutMs(): number {
  return store.getState().identity.signerType === "nip46" ? 90_000 : 12_000;
}

/** A saved NIP-46 bunker connection: the ephemeral client key + the bunker URI. */
export interface Nip46Connection {
  bunkerUri: string;
  clientSecretHex: string;
}

export async function saveNip46Connection(pubkey: string, conn: Nip46Connection): Promise<void> {
  await setSecret(nip46SecretKey(pubkey), JSON.stringify(conn));
}

export async function loadNip46Connection(pubkey?: string): Promise<Nip46Connection | null> {
  if (!pubkey) return null;
  const raw = await getSecret(nip46SecretKey(pubkey));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Nip46Connection;
    if (parsed?.bunkerUri && parsed?.clientSecretHex) return parsed;
  } catch {
    /* corrupt blob */
  }
  return null;
}

/** Close a signer that owns external resources (the NIP-46 bunker relay pool) without
 *  importing Nip46Signer here — keeps nostr-tools/nip46 out of this chunk. */
export function closeSignerIfRemote(signer: NostrSigner | null): void {
  const maybe = signer as { close?: () => Promise<void> } | null;
  if (maybe && typeof maybe.close === "function") {
    void maybe.close().catch(() => {});
  }
}

/** Open a bunker auth-challenge URL and nudge the user to approve it. The URL
 *  is bunker-supplied: only an https page is ever opened (bunkerAuthUrlOrNull);
 *  otherwise the notification alone tells the user to approve in the signer. */
function handleBunkerAuthUrl(rawUrl: string): void {
  store.dispatch(
    addNotification({
      id: `bunker-auth-${Date.now()}`,
      type: "chat",
      title: "Approve in your signer",
      body: "Your remote signer needs you to approve this request.",
      timestamp: Date.now(),
    }),
  );
  const url = bunkerAuthUrlOrNull(rawUrl);
  if (!url) {
    console.warn("[nip46] ignoring non-https auth_url from bunker");
    return;
  }
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    import("@tauri-apps/plugin-opener")
      .then((m) => m.openUrl(url))
      .catch((e) => console.error("[nip46] failed to open auth url", e));
  } else if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** The signer kinds a login can be started with. */
export type LoginSignerType = "nip07" | "tauri" | "nip46";

/** performLogin step 3: build the session's signer (it becomes
 *  `loginState.currentSigner`) and read its pubkey. */
export async function createSessionSigner(
  signerTypeOverride: LoginSignerType | undefined,
  knownPubkey: string | undefined,
  nip46Connect: Nip46Connection | undefined,
): Promise<{ signerType: LoginSignerType; pubkey: string }> {
  // Step 3: Detect/create signer and get pubkey
  const signerType = signerTypeOverride ?? (await detectSigner());
  if (!signerType) {
    throw new Error(
      "No signer available. Install a NIP-07 extension or use the Desktop app.",
    );
  }

  if (signerType === "nip46") {
    // Remote signer: build directly (it needs the bunker URI + ephemeral client key,
    // not a keychain pubkey, so it bypasses createSigner and the Rust active-pubkey
    // dance). The connection comes from the caller (fresh login / restore / switch),
    // falling back to the stored blob for knownPubkey.
    const connect = nip46Connect ?? (await loadNip46Connection(knownPubkey));
    if (!connect) {
      throw new Error("No saved bunker connection. Reconnect with your bunker URI.");
    }
    const { Nip46Signer } = await import("../nip46Signer");
    const { hexToBytes } = await import("@noble/hashes/utils");
    loginState.currentSigner = await Nip46Signer.connect(
      connect.bunkerUri,
      hexToBytes(connect.clientSecretHex),
      { onAuthUrl: handleBunkerAuthUrl, knownUserPubkey: knownPubkey },
    );
  } else {
    // For Tauri with a known pubkey (session restore / account switch), set the
    // Rust-side ACTIVE_PUBKEY BEFORE creating the signer. Without this, the Rust
    // keystore's get_active_secret_key sees ACTIVE_PUBKEY=None on fresh app start
    // and may fall through to generating a brand-new keypair instead of loading
    // the stored one.
    if (signerType === "tauri" && knownPubkey) {
      try {
        await TauriSigner.switchAccount(knownPubkey);
      } catch {
        // Key may not exist yet (first login / import) — getPublicKey will handle it
      }
    }
    loginState.currentSigner = await createSigner(signerType);
  }
  const signerPubkey = await loginState.currentSigner.getPublicKey();
  if (knownPubkey && knownPubkey !== signerPubkey) {
    // The signer returned a different key than the session expected. This means
    // the stored key was lost (keychain wiped, unsigned dev build, etc.). Do NOT
    // silently continue with the wrong key — that creates phantom accounts and
    // triggers the onboarding wizard.
    console.error(
      `[LoginFlow] Signer key mismatch — session=${knownPubkey.slice(0, 12)}… signer=${signerPubkey.slice(0, 12)}… — aborting login`,
    );
    throw new Error("Stored key not found in keystore. The key may have been removed from the OS keychain.");
  }
  const pubkey = signerPubkey;
  return { signerType, pubkey };
}
