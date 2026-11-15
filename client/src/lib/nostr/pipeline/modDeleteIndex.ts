import type { NostrEvent } from "../../../types/nostr";
import { EVENT_KINDS } from "../../../types/nostr";
import { inModGroup, verifySpaceModAuthority } from "../mutationAuthority";
import { removeChatMessage, hideMessage, removeEvent } from "../../../store/slices/eventsSlice";
import { removePoll } from "../../../store/slices/pollsSlice";
import type { PipelineContext } from "./types";
import type { Batching } from "./batching";

/**
 * kind:9005 (NIP-29) moderator deletes: the `case EVENT_KINDS.MOD_DELETE_EVENT`
 * of `indexEvent`. Synchronous on purpose: `indexEvent` calls it without
 * awaiting, exactly as the inline case ran.
 *
 * The body is the case as it stood in the switch, at its original indentation;
 * its four early `break`s out of the switch are `return`s here.
 */
export function createModDeleteIndexer(ctx: PipelineContext, batching: Batching) {
  const { deps, dispatch, getState, dedup } = ctx;
  const { flushEventPipeline } = batching;

  function indexModDelete(event: NostrEvent, relayUrl: string): void {
      // NIP-29 kind:9005: moderator delete — admin removes a message from the group.
      const groupId = event.tags.find((t) => t[0] === "h")?.[1];
      if (!groupId) return;

      // #5 — authority check. The chat read set includes non-enforcing mirrors and
      // imported relays, so anyone could publish a 9005 to wipe arbitrary messages.
      // Require the author to be in the space's pinned authority set, or (platform
      // spaces) the event to come from the space's own host relay, which enforces
      // the backend's MANAGE_MESSAGES roles.
      const space = getState().spaces.list.find((s) => s.id === groupId);
      const verdict = verifySpaceModAuthority(event, space, relayUrl);
      if (verdict === "defer-unknown-space") {
        // Space not loaded yet (rare race: spaces hydrate before chat subs open).
        // Drop without persisting and unmark so a relay redelivery can retry once
        // the space metadata is present.
        dedup.unmarkSeen(event.id);
        return;
      }
      if (verdict === "defer-host-relay") {
        // A platform space's role-holding moderator is vouched for only by the
        // host relay's delivery. Leave the id unseen so that copy is processed
        // even when a mirror delivered this one first.
        dedup.unmarkSeen(event.id);
        return;
      }
      if (verdict === "drop-unauthorized") {
        return;
      }

      // Apply buffered adds first so refs to same-burst messages resolve.
      flushEventPipeline();
      for (const tag of event.tags) {
        if (tag[0] === "e" && tag[1]) {
          const refEvent = getState().events.entities[tag[1]];
          if (refEvent) {
            // Scope hardening: only delete messages that actually belong to THIS
            // group, so an admin of one (e.g. self-imported) group can't delete
            // another group's messages, or an untagged public note, by id.
            if (!inModGroup(refEvent, groupId)) continue;
            const refChannelTag = refEvent.tags.find((t) => t[0] === "channel")?.[1];
            const contextId = refChannelTag ? `${groupId}:${refChannelTag}` : groupId;
            dispatch(removeChatMessage({ contextId, eventId: tag[1] }));
            dispatch(hideMessage(tag[1]));
            dispatch(removeEvent(tag[1]));
            if (refEvent.kind === EVENT_KINDS.POLL) {
              dispatch(removePoll(tag[1]));
            }
            deps.persistence.deleteEvent(tag[1]).catch(() => {});
          }
        }
      }
      deps.persistence.putEvent(event).catch(() => {});
  }

  return { indexModDelete };
}
