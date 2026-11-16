// Seam between the event pipeline and the encrypted-spaces feature
// (features/spaces/e2ee, docs/E2EE_SPACES.md). The pipeline must not import the
// feature (it signs and publishes, which import the pipeline), so the feature
// registers itself here at startup. Until it does, and whenever it declines,
// the two contract kinds are dropped without being indexed.

import type { NostrEvent } from "@/types/nostr";

export type SealedOpenResult =
  /** Decrypted: `event` is the inner event under the outer id (sealedAsEvent). */
  | { status: "opened"; event: NostrEvent }
  /** No key for its epoch yet; the feature keeps it and re-submits it later. */
  | { status: "parked" }
  /** A final verdict about this event (bad ciphertext, wrong author, replay…). */
  | { status: "rejected" }
  /** Not judged (feature off, account state not loaded): let a later copy in. */
  | { status: "declined" };

export interface SpaceE2eeHooks {
  /** A verified kind-4291 key grant arrived. Returns false when not judged. */
  onKeyGrant(event: NostrEvent): boolean;
  /** A verified kind-4290 sealed event arrived from `relayUrl`. */
  openSealed(event: NostrEvent, relayUrl: string): SealedOpenResult;
}

let hooks: SpaceE2eeHooks | null = null;

export function registerSpaceE2eeHooks(next: SpaceE2eeHooks | null): void {
  hooks = next;
}

export function getSpaceE2eeHooks(): SpaceE2eeHooks | null {
  return hooks;
}
