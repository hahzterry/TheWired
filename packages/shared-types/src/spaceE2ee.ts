// End-to-end encrypted spaces — shared TYPES and constants (docs/E2EE_SPACES.md).
// PROVISIONAL: the wire format is behind a default-off feature and the open
// decisions in that doc's §0 can still change every value here. Keep this file
// free of runtime logic; the codec lives in @ishtarservices/core
// (crypto/spaceKeys).

/** Bumped only for breaking wire changes (kinds, tags, salt, payload `v`). */
export const SPACE_E2EE_VERSION = 1 as const;

/** Event kinds of the encrypted-space contract. */
export const SPACE_E2EE_KINDS = {
  /** Sealed space event: an `h`-tagged event whose content is a NIP-44
   *  ciphertext of an unsigned inner event (the rumor), under the epoch key. */
  SEALED_EVENT: 4290,
  /** Space key grant: carries one epoch key wrapped to up to
   *  SPACE_KEY_GRANT_MAX_RECIPIENTS members. */
  KEY_GRANT: 4291,
} as const;

/** HKDF salt for every derivation from an epoch key. */
export const SPACE_E2EE_SALT = "thewired-space-e2ee-v1";

// ── Committed space ids (docs/E2EE_SPACES.md §5.4, D12) ──────────────────────
//
// An encrypted space's id commits to its key root:
//
//   id   = "e2e1-" + hex( SHA-256( "thewired-space-id-v1" || 0x00 || root || salt ) )[0..32]
//   root = the key root's pubkey, 32 bytes
//   salt = 16 random bytes chosen at creation, carried in every grant
//
// so any device that knows the id can check a grant's root with no server
// input. 128 bits of the hash; lowercase hex and '-' only, valid as a NIP-29
// group id. The prefix makes the format recognizable: a space whose id has
// this form is encrypted, and only such a space can be.

/** Prefix of a committed (encrypted) space id; the 1 is the format version. */
export const SPACE_E2EE_ID_PREFIX = "e2e1-";
/** A committed space id: the prefix and 32 lowercase hex characters. */
export const SPACE_E2EE_ID_RE = /^e2e1-[0-9a-f]{32}$/;
/** Domain-separation tag hashed into a committed id. */
export const SPACE_E2EE_ID_DOMAIN = "thewired-space-id-v1";
/** Bytes of salt in a committed id. */
export const SPACE_E2EE_ID_SALT_BYTES = 16;

/** Tag names on the outer events. */
export const SPACE_E2EE_TAGS = {
  /** `["epoch", <16 hex>]` — names the epoch key the event is under. */
  EPOCH: "epoch",
  /** `["eph", <64 hex>]` — the throwaway pubkey a grant's `p` entries are
   *  NIP-44-encrypted from. */
  EPHEMERAL: "eph",
  /** `["root", <64 hex pubkey>, <32 hex salt>]` on a grant — the opening of
   *  the space id's commitment, public so a device can check a grant's root
   *  before asking its signer to decrypt anything. Must match the payload. */
  ROOT: "root",
} as const;

/** Rumor kinds a receiver accepts inside a sealed event; others are dropped. */
export const SPACE_SEALED_RUMOR_KINDS: readonly number[] = [9];

/** Recipients one grant event may carry; more go in further grant events. */
export const SPACE_KEY_GRANT_MAX_RECIPIENTS = 80;

/** Upper bound on the serialized rumor JSON, bytes. */
export const SPACE_SEALED_MAX_PLAINTEXT_BYTES = 65535;

/**
 * Plaintext kinds a client may still publish with an encrypted space's `h`
 * tag: deletion, NIP-29 management, the two contract kinds, reports, the
 * NIP-78 layout overlays and voice-room metadata / presence (NIP-53). Everything
 * else must be sealed.
 */
export const SPACE_E2EE_PLAINTEXT_KINDS: readonly number[] = [
  5, 1984, 9000, 9001, 9002, 9005, 9007, 9008, 9009, 9021, 9022, 10312, 30078, 30312,
  SPACE_E2EE_KINDS.SEALED_EVENT,
  SPACE_E2EE_KINDS.KEY_GRANT,
];

/** What a new member is given on joining. */
export type SpaceHistoryPolicy = "epoch" | "full";

/** The unsigned inner event of a sealed space event. */
export interface SpaceRumor {
  /** sha256 of the NIP-01 serialization; recomputed by the receiver. */
  id: string;
  /** MUST equal the sealed event's pubkey. */
  pubkey: string;
  created_at: number;
  kind: number;
  /** MUST include `["h", <spaceId>]` equal to the sealed event's. */
  tags: string[][];
  content: string;
}

/** The encrypted payload of a key grant (JSON, under the epoch's grant key). */
export interface SpaceKeyGrantPayload {
  v: typeof SPACE_E2EE_VERSION;
  space: string;
  /** 16-hex epoch id; MUST equal the grant's `epoch` tag. */
  epoch: string;
  /** 0 for the first epoch, +1 per rotation. */
  seq: number;
  /** The epoch this one replaced, or null for the first. */
  prev: string | null;
  /** The space's key root: who made the first epoch and may always issue
   *  keys. The same in every epoch of a space; receivers pin it. */
  root: string;
  /** The salt (32 hex) that, with `root`, hashes to the space id. */
  rootSalt: string;
  /** Pubkeys allowed to issue the NEXT epoch (and late grants of this one).
   *  Always includes `root`. */
  managers: string[];
  history: SpaceHistoryPolicy;
  /** Unix seconds the epoch was created. */
  at: number;
}

/** Non-secret description of an epoch a device holds (safe for Redux / IDB). */
export interface SpaceEpochInfo {
  id: string;
  seq: number;
  prev: string | null;
  managers: string[];
  history: SpaceHistoryPolicy;
  at: number;
  /** Who signed the grant this device accepted. */
  grantedBy: string;
}
