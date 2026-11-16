// Invite links for backend-backed spaces (docs/E2EE_SPACES.md §5.4, D12).
//
//   https://<public web origin>/invite/<code>/<spaceId>   encrypted spaces
//   https://<public web origin>/invite/<code>             every other space
//
// The code is the backend's; for an encrypted space the inviter's client puts
// the space id in the link, so the server that resolves the code cannot change
// it, and the joining client refuses when the server resolves the code to
// another space. The id is a path segment, not a query or fragment: the public
// invite page and every client parser keep the path whole, while a query or
// fragment is dropped along the way.
//
// Plain spaces get the short form for now: clients released before the longer
// form route only `/invite/<code>` and drop anything else. Both
// forms are parsed and checked here whatever the space. Links without the id
// still work for plain spaces; for an encrypted space they cannot be checked,
// and are refused.

import { isEncryptedSpaceId } from "./e2ee/spaceIdFormat";

const SEGMENT = "[A-Za-z0-9_-]+";
/** `/invite/<code>` with an optional `/<spaceId>`, anywhere in a path or URL. */
export const INVITE_PATH_RE = new RegExp(`/invite/(${SEGMENT})(?:/(${SEGMENT}))?`);

export interface ParsedInvite {
  code: string;
  /** The space the inviter's link names, when it names one. */
  spaceId?: string;
}

/** The path of an invite link for `code` into `spaceId`: the space id is in
 *  the link for an encrypted space only (see the header). */
export function invitePath(code: string, spaceId: string): string {
  const base = `/invite/${encodeURIComponent(code)}`;
  return isEncryptedSpaceId(spaceId) ? `${base}/${encodeURIComponent(spaceId)}` : base;
}

/** Parse an invite link, deep-link path or bare code. */
export function parseInviteLink(input: string): ParsedInvite {
  const trimmed = input.trim();
  let path: string | null = null;
  try {
    const url = new URL(trimmed);
    path = url.pathname;
    if (!INVITE_PATH_RE.test(path)) {
      const param = url.searchParams.get("invite");
      if (param) return { code: param };
    }
  } catch {
    if (trimmed.startsWith("/invite/")) path = trimmed;
  }
  const match = path ? INVITE_PATH_RE.exec(path) : null;
  if (match) return match[2] ? { code: match[1], spaceId: match[2] } : { code: match[1] };
  return { code: trimmed };
}

export type InviteVerdict =
  | { ok: true }
  | { ok: false; reason: "mismatch" | "unverifiable"; message: string };

export const INVITE_MISMATCH_MESSAGE =
  "This invite doesn't lead to the space it was made for: the server answered with a different space. Don't join; ask for a new invite.";
export const INVITE_UNVERIFIABLE_MESSAGE =
  "This space is end-to-end encrypted, and this invite link doesn't say which space it is for, so it can't be checked. Ask for a new invite link.";

/**
 * Check the space the server resolved an invite code to against the one the
 * link names. A link that names none is fine for a plain space (old links),
 * and never for an encrypted one.
 */
export function verifyInviteSpace(linked: string | undefined, resolved: string): InviteVerdict {
  if (linked !== undefined) {
    return linked === resolved ? { ok: true } : { ok: false, reason: "mismatch", message: INVITE_MISMATCH_MESSAGE };
  }
  if (isEncryptedSpaceId(resolved)) return { ok: false, reason: "unverifiable", message: INVITE_UNVERIFIABLE_MESSAGE };
  return { ok: true };
}
