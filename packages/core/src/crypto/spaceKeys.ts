// Space keys v1 — the codec for end-to-end encrypted spaces (docs/E2EE_SPACES.md).
// PROVISIONAL wire format, behind a default-off feature.
//
// A space has one 32-byte key per EPOCH. Chat travels as a "sealed space
// event" (an ordinary h-tagged event the relay gates like kind 9, whose
// content is NIP-44 ciphertext of an unsigned inner event under a key derived
// from the epoch key). The epoch key reaches members in a "key grant" event:
// hex(K) NIP-44-encrypted to each member from a throwaway keypair, so the
// granter signs once however many members there are.
//
// Platform-free and pure: no store, no signer. The one account-key operation
// (unwrapping your own grant entry) is passed in as a decrypt callback.
// Everything fails closed by throwing SpaceE2eeError. Nothing here logs.

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { encrypt, decrypt } from "nostr-tools/nip44";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";
import {
  SPACE_E2EE_KINDS,
  SPACE_E2EE_SALT,
  SPACE_E2EE_TAGS,
  SPACE_E2EE_VERSION,
  SPACE_KEY_GRANT_MAX_RECIPIENTS,
  SPACE_SEALED_MAX_PLAINTEXT_BYTES,
  SPACE_SEALED_RUMOR_KINDS,
  type NostrEvent,
  type SpaceHistoryPolicy,
  type SpaceKeyGrantPayload,
  type SpaceRumor,
  type UnsignedEvent,
} from "@ishtarservices/shared-types";
import { getEventId } from "./giftWrap";
import { nip44EncryptWithKey } from "./nip44";

export const SPACE_EPOCH_KEY_BYTES = 32;

const HEX64_RE = /^[0-9a-f]{64}$/;
const EPOCH_ID_RE = /^[0-9a-f]{16}$/;

export type SpaceE2eeErrorCode =
  /** The outer event is not a well-formed sealed event / grant. */
  | "malformed"
  /** NIP-44 refused the ciphertext: wrong key or tampered. */
  | "decrypt"
  /** The key does not match the event's `epoch` tag. */
  | "epoch"
  /** The rumor's author is not the outer event's author. */
  | "sender"
  /** The rumor / payload names another space than the outer `h` tag. */
  | "space"
  /** The rumor's id does not match its content. */
  | "id"
  /** A rumor kind this version does not accept. */
  | "kind"
  /** The grant has no entry for this pubkey. */
  | "not-recipient"
  /** Too large to seal. */
  | "size";

/** Every verdict the codec reaches itself. Final for that event: retrying the
 *  same bytes with the same key gives the same answer. */
export class SpaceE2eeError extends Error {
  readonly code: SpaceE2eeErrorCode;
  constructor(code: SpaceE2eeErrorCode, message: string) {
    super(message);
    this.name = "SpaceE2eeError";
    this.code = code;
  }
}

// ── Key derivation ───────────────────────────────────────────────────────────

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== SPACE_EPOCH_KEY_BYTES) {
    throw new SpaceE2eeError("malformed", "epoch key must be 32 bytes");
  }
}

function derive(key: Uint8Array, info: string, length: number): Uint8Array {
  assertKey(key);
  return hkdf(sha256, key, utf8ToBytes(SPACE_E2EE_SALT), utf8ToBytes(info), length);
}

/** A fresh epoch key from the platform CSPRNG. */
export function generateEpochKey(): Uint8Array {
  return randomBytes(SPACE_EPOCH_KEY_BYTES);
}

/** The public 16-hex name of an epoch key. */
export function epochIdOf(key: Uint8Array): string {
  return bytesToHex(derive(key, "epoch-id", 8));
}

/** NIP-44 conversation key for sealed events of `spaceId` under this epoch. */
export function spaceContentKey(key: Uint8Array, spaceId: string): Uint8Array {
  return derive(key, `content:${spaceId}`, 32);
}

/** NIP-44 conversation key for the grant payload of `spaceId` under this epoch. */
export function spaceGrantKey(key: Uint8Array, spaceId: string): Uint8Array {
  return derive(key, `grant:${spaceId}`, 32);
}

// ── Tag helpers ──────────────────────────────────────────────────────────────

function tagValues(tags: string[][], name: string): string[] {
  const out: string[] = [];
  for (const t of tags) if (Array.isArray(t) && t[0] === name && typeof t[1] === "string") out.push(t[1]);
  return out;
}

function single(tags: string[][], name: string): string | null {
  const values = tagValues(tags, name);
  return values.length === 1 && values[0] !== "" ? values[0] : null;
}

function nip44Open(payload: string, conversationKey: Uint8Array): string {
  try {
    return decrypt(payload, conversationKey);
  } catch {
    throw new SpaceE2eeError("decrypt", "could not decrypt (wrong key or altered ciphertext)");
  }
}

// ── Sealed space events (kind 4290) ──────────────────────────────────────────

/** Build the unsigned inner event. `tags` need not carry the `h` tag; it is
 *  added (first) when missing. */
export function buildSpaceRumor(
  pubkey: string,
  spaceId: string,
  kind: number,
  tags: string[][],
  content: string,
  createdAt: number = Math.floor(Date.now() / 1000),
): SpaceRumor {
  const hasH = tags.some((t) => t[0] === "h");
  if (hasH && single(tags, "h") !== spaceId) {
    throw new SpaceE2eeError("space", "rumor h tag names another space");
  }
  const body = {
    pubkey,
    created_at: createdAt,
    kind,
    tags: hasH ? tags : [["h", spaceId], ...tags],
    content,
  };
  return { id: getEventId(body), ...body };
}

/** Seal `rumor` under `epochKey`. Returns the unsigned outer event; the
 *  caller signs it with the rumor author's own key. */
export function sealSpaceEvent(rumor: SpaceRumor, spaceId: string, epochKey: Uint8Array): UnsignedEvent {
  if (single(rumor.tags, "h") !== spaceId) {
    throw new SpaceE2eeError("space", "rumor h tag names another space");
  }
  const plaintext = JSON.stringify(rumor);
  if (utf8ToBytes(plaintext).length > SPACE_SEALED_MAX_PLAINTEXT_BYTES) {
    throw new SpaceE2eeError("size", "message is too long to encrypt");
  }
  return {
    pubkey: rumor.pubkey,
    created_at: rumor.created_at,
    kind: SPACE_E2EE_KINDS.SEALED_EVENT,
    tags: [
      ["h", spaceId],
      [SPACE_E2EE_TAGS.EPOCH, epochIdOf(epochKey)],
    ],
    content: encrypt(plaintext, spaceContentKey(epochKey, spaceId)),
  };
}

export interface SealedHeader {
  spaceId: string;
  epochId: string;
}

/** The routing fields of a sealed event, or null when it is not well-formed.
 *  Needs no key: this is what a receiver uses to find the key. */
export function readSealedHeader(event: Pick<NostrEvent, "kind" | "tags">): SealedHeader | null {
  if (event.kind !== SPACE_E2EE_KINDS.SEALED_EVENT || !Array.isArray(event.tags)) return null;
  const spaceId = single(event.tags, "h");
  const epochId = single(event.tags, SPACE_E2EE_TAGS.EPOCH);
  if (!spaceId || !epochId || !EPOCH_ID_RE.test(epochId)) return null;
  return { spaceId, epochId };
}

export interface OpenSealedOptions {
  /** Rumor kinds to accept. Defaults to SPACE_SEALED_RUMOR_KINDS. */
  acceptKinds?: readonly number[];
}

/**
 * Open a sealed space event with the epoch key its `epoch` tag names. The
 * caller has already verified the outer signature. Throws SpaceE2eeError.
 */
export function openSealedSpaceEvent(
  event: Pick<NostrEvent, "kind" | "pubkey" | "tags" | "content">,
  epochKey: Uint8Array,
  opts?: OpenSealedOptions,
): SpaceRumor {
  const header = readSealedHeader(event);
  if (!header) throw new SpaceE2eeError("malformed", "not a sealed space event");
  if (epochIdOf(epochKey) !== header.epochId) {
    throw new SpaceE2eeError("epoch", "key is for another epoch");
  }

  const plaintext = nip44Open(event.content, spaceContentKey(epochKey, header.spaceId));
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new SpaceE2eeError("malformed", "sealed content is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SpaceE2eeError("malformed", "sealed content is not an event");
  }
  const r = parsed as Record<string, unknown>;
  if (
    typeof r.pubkey !== "string" ||
    typeof r.created_at !== "number" ||
    !Number.isFinite(r.created_at) ||
    typeof r.kind !== "number" ||
    !Number.isInteger(r.kind) ||
    typeof r.content !== "string" ||
    !Array.isArray(r.tags) ||
    !r.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === "string"))
  ) {
    throw new SpaceE2eeError("malformed", "sealed content is not an event");
  }
  const body = {
    pubkey: r.pubkey,
    created_at: r.created_at,
    kind: r.kind,
    tags: r.tags as string[][],
    content: r.content,
  };

  if (body.pubkey !== event.pubkey) {
    throw new SpaceE2eeError("sender", "sealed event author does not match its content");
  }
  if (single(body.tags, "h") !== header.spaceId) {
    throw new SpaceE2eeError("space", "sealed content is for another space");
  }
  const id = getEventId(body);
  if (r.id !== undefined && r.id !== id) {
    throw new SpaceE2eeError("id", "sealed content id mismatch");
  }
  const accept = opts?.acceptKinds ?? SPACE_SEALED_RUMOR_KINDS;
  if (!accept.includes(body.kind)) {
    throw new SpaceE2eeError("kind", "unsupported sealed kind");
  }
  return { id, ...body };
}

/**
 * The event a client stores and renders for an opened sealed event: the
 * rumor's kind, tags and content under the OUTER event's id, time and
 * signature. References between sealed messages (`e` / `q`) and relay
 * deletions use the outer id, so this is the identity everything else keys on.
 * It does not verify as a signed event and must never be published.
 */
export function sealedAsEvent(outer: NostrEvent, rumor: SpaceRumor): NostrEvent {
  return {
    id: outer.id,
    pubkey: outer.pubkey,
    created_at: outer.created_at,
    kind: rumor.kind,
    tags: rumor.tags,
    content: rumor.content,
    sig: outer.sig,
  };
}

// ── Key grants (kind 4291) ───────────────────────────────────────────────────

export interface BuildGrantsArgs {
  /** The manager publishing the grant (signs the returned events). */
  granter: string;
  spaceId: string;
  epochKey: Uint8Array;
  seq: number;
  prev: string | null;
  /** The space's key root (docs/E2EE_SPACES.md §5.4). */
  root: string;
  managers: string[];
  history: SpaceHistoryPolicy;
  /** When the epoch was created (unix seconds); carried on late grants. */
  at: number;
  /** Who receives the key. De-duplicated; order kept. */
  recipients: string[];
  createdAt?: number;
}

/** The payload a grant for this epoch carries. */
export function grantPayload(args: Omit<BuildGrantsArgs, "granter" | "recipients" | "createdAt">): SpaceKeyGrantPayload {
  return {
    v: SPACE_E2EE_VERSION,
    space: args.spaceId,
    epoch: epochIdOf(args.epochKey),
    seq: args.seq,
    prev: args.prev,
    root: args.root,
    // The root is always a manager.
    managers: [...new Set([args.root, ...args.managers])],
    history: args.history,
    at: args.at,
  };
}

/**
 * Build the unsigned grant event(s) handing `epochKey` to `recipients`: one
 * event per SPACE_KEY_GRANT_MAX_RECIPIENTS, each with its own throwaway key.
 * The granter signs each once; no account-key encryption is involved.
 */
export function buildSpaceKeyGrants(args: BuildGrantsArgs): UnsignedEvent[] {
  if (!HEX64_RE.test(args.granter)) throw new SpaceE2eeError("malformed", "granter must be a pubkey");
  if (!HEX64_RE.test(args.root)) throw new SpaceE2eeError("malformed", "root must be a pubkey");
  if (!Number.isInteger(args.seq) || args.seq < 0 || (args.seq === 0) !== (args.prev === null)) {
    throw new SpaceE2eeError("malformed", "the first epoch has seq 0 and no prev; later ones have both");
  }
  const recipients = [...new Set(args.recipients)];
  for (const pk of recipients) {
    if (!HEX64_RE.test(pk)) throw new SpaceE2eeError("malformed", "recipient must be a pubkey");
  }
  if (recipients.length === 0) return [];

  const payload = grantPayload(args);
  const keyHex = bytesToHex(args.epochKey);
  const grantKey = spaceGrantKey(args.epochKey, args.spaceId);
  const createdAt = args.createdAt ?? Math.floor(Date.now() / 1000);

  const events: UnsignedEvent[] = [];
  for (let i = 0; i < recipients.length; i += SPACE_KEY_GRANT_MAX_RECIPIENTS) {
    const chunk = recipients.slice(i, i + SPACE_KEY_GRANT_MAX_RECIPIENTS);
    const ephemeral = generateSecretKey();
    const tags: string[][] = [
      ["h", args.spaceId],
      [SPACE_E2EE_TAGS.EPOCH, payload.epoch],
      [SPACE_E2EE_TAGS.EPHEMERAL, getPublicKey(ephemeral)],
    ];
    for (const pk of chunk) tags.push(["p", pk, nip44EncryptWithKey(ephemeral, pk, keyHex)]);
    ephemeral.fill(0);
    events.push({
      pubkey: args.granter,
      created_at: createdAt,
      kind: SPACE_E2EE_KINDS.KEY_GRANT,
      tags,
      // A fresh NIP-44 nonce per event, so the same payload never repeats.
      content: encrypt(JSON.stringify(payload), grantKey),
    });
  }
  return events;
}

export interface GrantHeader {
  spaceId: string;
  epochId: string;
  ephemeralPubkey: string;
  /** Every pubkey this grant event hands the key to. */
  recipients: string[];
}

/** The public fields of a grant, or null when it is not well-formed. */
export function readGrantHeader(event: Pick<NostrEvent, "kind" | "tags">): GrantHeader | null {
  if (event.kind !== SPACE_E2EE_KINDS.KEY_GRANT || !Array.isArray(event.tags)) return null;
  const spaceId = single(event.tags, "h");
  const epochId = single(event.tags, SPACE_E2EE_TAGS.EPOCH);
  const ephemeralPubkey = single(event.tags, SPACE_E2EE_TAGS.EPHEMERAL);
  if (!spaceId || !epochId || !EPOCH_ID_RE.test(epochId)) return null;
  if (!ephemeralPubkey || !HEX64_RE.test(ephemeralPubkey)) return null;
  const recipients: string[] = [];
  for (const t of event.tags) {
    if (t[0] !== "p") continue;
    if (!HEX64_RE.test(t[1] ?? "") || typeof t[2] !== "string" || t[2] === "") return null;
    if (!recipients.includes(t[1])) recipients.push(t[1]);
  }
  if (recipients.length === 0 || recipients.length > SPACE_KEY_GRANT_MAX_RECIPIENTS) return null;
  return { spaceId, epochId, ephemeralPubkey, recipients };
}

function parseGrantPayload(plaintext: string, header: GrantHeader): SpaceKeyGrantPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new SpaceE2eeError("malformed", "grant payload is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SpaceE2eeError("malformed", "grant payload is not an object");
  }
  const p = parsed as Record<string, unknown>;
  if (p.v !== SPACE_E2EE_VERSION) throw new SpaceE2eeError("malformed", "unsupported grant version");
  if (p.space !== header.spaceId) throw new SpaceE2eeError("space", "grant is for another space");
  if (p.epoch !== header.epochId) throw new SpaceE2eeError("epoch", "grant is for another epoch");
  if (typeof p.seq !== "number" || !Number.isInteger(p.seq) || p.seq < 0) {
    throw new SpaceE2eeError("malformed", "grant seq is invalid");
  }
  if (p.prev !== null && (typeof p.prev !== "string" || !EPOCH_ID_RE.test(p.prev))) {
    throw new SpaceE2eeError("malformed", "grant prev is invalid");
  }
  // The first epoch, and only the first, has no predecessor; an epoch never
  // names itself.
  if ((p.seq === 0) !== (p.prev === null) || p.prev === header.epochId) {
    throw new SpaceE2eeError("malformed", "grant seq and prev disagree");
  }
  if (typeof p.root !== "string" || !HEX64_RE.test(p.root)) {
    throw new SpaceE2eeError("malformed", "grant root is invalid");
  }
  if (!Array.isArray(p.managers) || !p.managers.every((m) => typeof m === "string" && HEX64_RE.test(m))) {
    throw new SpaceE2eeError("malformed", "grant managers are invalid");
  }
  if (!p.managers.includes(p.root)) {
    throw new SpaceE2eeError("malformed", "grant managers must include the root");
  }
  if (p.history !== "epoch" && p.history !== "full") {
    throw new SpaceE2eeError("malformed", "grant history policy is invalid");
  }
  if (typeof p.at !== "number" || !Number.isFinite(p.at)) {
    throw new SpaceE2eeError("malformed", "grant time is invalid");
  }
  return {
    v: SPACE_E2EE_VERSION,
    space: header.spaceId,
    epoch: header.epochId,
    seq: p.seq,
    prev: p.prev as string | null,
    root: p.root,
    managers: [...new Set(p.managers as string[])],
    history: p.history,
    at: p.at,
  };
}

/** Read a grant's payload with an epoch key already held (a manager checking
 *  another manager's grant, or a device re-reading its own). */
export function openSpaceKeyGrantWithKey(
  event: Pick<NostrEvent, "kind" | "tags" | "content">,
  epochKey: Uint8Array,
): SpaceKeyGrantPayload {
  const header = readGrantHeader(event);
  if (!header) throw new SpaceE2eeError("malformed", "not a space key grant");
  if (epochIdOf(epochKey) !== header.epochId) throw new SpaceE2eeError("epoch", "key is for another epoch");
  return parseGrantPayload(nip44Open(event.content, spaceGrantKey(epochKey, header.spaceId)), header);
}

export interface OpenedGrant {
  key: Uint8Array;
  payload: SpaceKeyGrantPayload;
  header: GrantHeader;
}

/**
 * Unwrap a grant addressed to `myPubkey`. `nip44Decrypt(peer, ciphertext)` is
 * the account signer's NIP-44 decryption (the single account-key operation an
 * epoch costs). A failure of that callback is rethrown as-is: it says nothing
 * about the grant (signer locked, remote signer timed out), so the caller may
 * retry. Verdicts about the grant itself throw SpaceE2eeError.
 *
 * The caller has verified the signature and decides whether the signer may
 * issue keys for the space (docs/E2EE_SPACES.md §5.4).
 */
export async function openSpaceKeyGrant(
  event: Pick<NostrEvent, "kind" | "tags" | "content">,
  myPubkey: string,
  nip44Decrypt: (peerPubkey: string, ciphertext: string) => Promise<string>,
): Promise<OpenedGrant> {
  const header = readGrantHeader(event);
  if (!header) throw new SpaceE2eeError("malformed", "not a space key grant");
  const entry = event.tags.find((t) => t[0] === "p" && t[1] === myPubkey)?.[2];
  if (!entry) throw new SpaceE2eeError("not-recipient", "grant has no entry for this account");

  const keyHex = await nip44Decrypt(header.ephemeralPubkey, entry);
  if (typeof keyHex !== "string" || !HEX64_RE.test(keyHex)) {
    // Some signers return garbage instead of throwing on a wrong key.
    throw new SpaceE2eeError("decrypt", "grant entry did not decrypt to a key");
  }
  const key = hexToBytes(keyHex);
  if (epochIdOf(key) !== header.epochId) throw new SpaceE2eeError("epoch", "granted key is for another epoch");
  const payload = parseGrantPayload(nip44Open(event.content, spaceGrantKey(key, header.spaceId)), header);
  return { key, payload, header };
}

// ── Epoch choice ─────────────────────────────────────────────────────────────

/** Order epochs newest-first for SENDING: highest seq, ties to the smaller id. */
export function compareEpochsForSend(a: { id: string; seq: number }, b: { id: string; seq: number }): number {
  if (a.seq !== b.seq) return b.seq - a.seq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The epoch a sender must seal with, or null when none is held. */
export function pickSendEpoch<T extends { id: string; seq: number }>(epochs: readonly T[]): T | null {
  if (epochs.length === 0) return null;
  return [...epochs].sort(compareEpochsForSend)[0];
}


// ── Who may issue an epoch (docs/E2EE_SPACES.md §5.4) ───────────────────────

/** What a device knows about an epoch it accepted. */
export interface KnownEpoch {
  id: string;
  seq: number;
  prev: string | null;
  managers: readonly string[];
}

export type GrantVerdict =
  /** Accept the epoch. */
  | "accept"
  /** Not acceptable now, but may be once the epochs it links to arrive
   *  (grants reach a device in no particular order). Keep it and retry. */
  | "defer"
  /** Never acceptable for this space. */
  | "reject";

/**
 * Pure: may a device that has pinned `root` and accepted `known` epochs accept
 * the epoch described by `payload`, from a grant signed by `signer`?
 *
 *  - The payload must name the pinned root.
 *  - The root may issue anything.
 *  - Anyone else must EXTEND the chain this device knows: the epoch's `prev`
 *    is an accepted epoch, its `seq` is exactly one more, and the signer is a
 *    manager of that predecessor. So nobody but the root can jump ahead of the
 *    chain or start a second one, and a manager dropped at a rotation cannot
 *    issue anything after it.
 *  - Or it fills in history: an accepted epoch names it as `prev` with a `seq`
 *    one more, and the signer manages some accepted epoch.
 */
export function judgeEpochGrant(
  payload: Pick<SpaceKeyGrantPayload, "epoch" | "seq" | "prev" | "root">,
  signer: string,
  root: string,
  known: readonly KnownEpoch[],
): GrantVerdict {
  if (payload.root !== root) return "reject";
  if (signer === root) return "accept";

  if (payload.prev !== null) {
    const parent = known.find((e) => e.id === payload.prev);
    if (parent) {
      return payload.seq === parent.seq + 1 && parent.managers.includes(signer) ? "accept" : "reject";
    }
  }
  const child = known.find((e) => e.prev === payload.epoch);
  if (child) {
    return child.seq === payload.seq + 1 && known.some((e) => e.managers.includes(signer)) ? "accept" : "reject";
  }
  // The first epoch can only come from the root; anything else may still link up.
  return payload.prev === null ? "reject" : "defer";
}
