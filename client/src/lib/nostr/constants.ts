/** The Wired's own relay — guaranteed to accept all event kinds including gift wraps */
export const APP_RELAY = import.meta.env.VITE_RELAY_URL ?? "ws://localhost:7777";

/** General-purpose writable relays used before the user's relay list is loaded.
 *  Safe for PUBLISH of any kind (gift wraps, kind:10002, etc) and for SUBSCRIBE.
 *  Dropped nostr.wine (paywalled, rejected writes with "restricted: sign up") and
 *  offchain.pub (20-sub cap with low payoff). */
export const BOOTSTRAP_RELAYS = [
  APP_RELAY,
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nos.lol",
];

/** READ-ONLY profile/relay-list indexer relays. They specialize in kind:0/3/10002 and
 *  reject most other kinds, so NEVER publish arbitrary events to them. Use them for
 *  fetching any pubkey's profile or NIP-65 relay list reliably. */
export const INDEXER_RELAYS = [
  "wss://purplepag.es",
  "wss://user.kindpag.es",
];

/** Targeted relays for profile data lookups (kind:0, kind:1, kind:3, kind:6, kind:30023).
 *  Combines the indexer specialists with damus.io (300-sub cap absorbs traffic that
 *  20-cap relays like primal/nos.lol would defer). */
export const PROFILE_RELAYS = [
  APP_RELAY,
  ...INDEXER_RELAYS,
  "wss://relay.damus.io",
];

/** Curated public NIP-29 group relays offered in the Decentralized Spaces relay
 *  picker. The Wired's own relay (APP_RELAY) is always offered first; these are
 *  well-known interoperable hosts. Capability is verified live via NIP-11 probe,
 *  so an entry that stops supporting NIP-29 simply shows a warning badge. */
export const NIP29_RELAY_PRESETS: { url: string; label: string }[] = [
  { url: "wss://groups.0xchat.com", label: "0xchat Groups" },
  { url: "wss://groups.fiatjaf.com", label: "fiatjaf Groups" },
  { url: "wss://relay.groups.nip29.com", label: "nip29.com" },
];

/** Reconnection backoff parameters */
export const RECONNECT = {
  /** Initial delay in ms */
  BASE_DELAY: 1000,
  /** Maximum delay cap in ms */
  MAX_DELAY: 60_000,
  /** Jitter factor (+/- this percentage) */
  JITTER: 0.25,
  /** Number of disconnects within STORM_WINDOW to trigger storm detection */
  STORM_THRESHOLD: 3,
  /** Time window for storm detection in ms */
  STORM_WINDOW: 5_000,
  /** Cooldown when storm detected in ms */
  STORM_COOLDOWN: 10_000,
  /** Consecutive failed connects after which a relay counts as dead: a fan-out
   *  target (one the user never chose) stops being dialed for the session, and
   *  a chosen relay moves to the long backoff below. */
  STRIKE_LIMIT: 3,
  /** Backoff cap for a dead relay the user chose (their own list, a space
   *  host): still retried, never dropped, but only this often. The app relay
   *  keeps MAX_DELAY. */
  DEAD_MAX_DELAY: 300_000,
  /** A socket has to stay open this long before the connect counts as a
   *  success. One that opens and closes sooner is a failed connect, so a relay
   *  that accepts and immediately hangs up cannot reset its own backoff. */
  STABLE_AFTER: 5_000,
  /** A connect attempt that has not opened by now is abandoned and counted as
   *  failed (a black-holed host otherwise sits in "connecting" for minutes). */
  CONNECT_TIMEOUT: 15_000,
  /** Dials allowed back to back before the rest of a burst is spaced out. */
  DIAL_BURST: 4,
  /** Gap between queued dials once a burst is being spaced out, in ms. */
  DIAL_SPACING: 40,
} as const;

/** Subscription limits */
export const SUBSCRIPTION = {
  /** Maximum subscription ID length per NIP-01 */
  MAX_SUB_ID_LENGTH: 64,
} as const;
