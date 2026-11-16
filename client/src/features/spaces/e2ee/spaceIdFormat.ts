// Is a space end-to-end encrypted? Decided from its id alone
// (docs/E2EE_SPACES.md §5.4): an encrypted space's id commits to its key root
// and has a recognizable form, and no other space can be encrypted.
//
// Deliberately tiny and dependency-free apart from one constant: the publish
// guard, the ingest guard and the composer use it, so it is on the startup path.

import { SPACE_E2EE_ID_RE } from "@ishtarservices/shared-types";

export function isEncryptedSpaceId(id: string | null | undefined): boolean {
  return typeof id === "string" && SPACE_E2EE_ID_RE.test(id);
}

/** Does any `h` tag name an encrypted space? */
export function namesEncryptedSpace(tags: readonly (readonly string[])[]): boolean {
  return tags.some((t) => t[0] === "h" && isEncryptedSpaceId(t[1]));
}
