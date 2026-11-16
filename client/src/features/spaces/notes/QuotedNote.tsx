import { memo } from "react";
import { EmbeddedNote } from "../../../components/content/EmbeddedNote";
import { EmbedDepthContext } from "../../../components/content/embedDepth";
import { ItemBoundary } from "../../../components/ui/ErrorBoundary";

interface QuotedNoteProps {
  eventId: string;
  /** Relay hint from the NIP-18 `q` tag, if any. */
  relayHint?: string;
  /** Author pubkey from the NIP-18 `q` tag, if any. */
  pubkey?: string;
}

/**
 * A NIP-18 quoted note shown beneath a note's body. Renders the referenced
 * event as a compact, fetch-if-missing card (depth 1) — the same machinery that
 * powers inline `nostr:` embeds, so quotes resolve, are kind-aware, and don't
 * recurse without bound.
 */
export const QuotedNote = memo(function QuotedNote({ eventId, relayHint, pubkey }: QuotedNoteProps) {
  return (
    <EmbedDepthContext.Provider value={1}>
      <ItemBoundary id={eventId} label="embedded-note" noun="quoted note">
        <EmbeddedNote
          idRef={{
            id: eventId,
            relays: relayHint ? [relayHint] : undefined,
            author: pubkey || undefined,
          }}
        />
      </ItemBoundary>
    </EmbedDepthContext.Provider>
  );
});
