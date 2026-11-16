import type { NostrEvent } from "../../../types/nostr";
import { EVENT_KINDS } from "../../../types/nostr";
import { trackPendingDeletion } from "../../../store/slices/eventsSlice";
import { removeChatMessage, hideMessage, removeEvent, removeNote, removeRepost, trackDeletedNote, trackDeletedAddr } from "../../../store/slices/eventsSlice";
import { removeReactionByEventId } from "../../../store/slices/reactionsSlice";
import { removeVoteByEventId, removePoll } from "../../../store/slices/pollsSlice";
import { removeAnnotation, removeTrack, removeAlbum, removePlaylist } from "../../../store/slices/musicSlice";
import type { PipelineContext } from "./types";
import type { Batching } from "./batching";

/**
 * kind:5 (NIP-09) deletions: the `case EVENT_KINDS.DELETION` of `indexEvent`.
 * Synchronous on purpose: `indexEvent` calls it without awaiting, exactly as
 * the inline case ran.
 *
 * The body is the case as it stood in the switch, at its original indentation.
 */
export function createDeletionIndexer(ctx: PipelineContext, batching: Batching) {
  const { deps, dispatch, getState } = ctx;
  const { flushEventPipeline } = batching;

  function indexDeletion(event: NostrEvent): void {
    // NIP-09: Process deletion events -- remove referenced content.
    // Only process deletions from the same author (can't delete others' content).
    // Crucially, a deletion only applies to events created BEFORE the deletion.
    // Re-published addressable events (same kind:pubkey:d-tag but newer created_at)
    // supersede the deletion and must NOT be removed.
    // Apply any buffered adds first so same-burst deletion targets resolve.
    flushEventPipeline();
    const state = getState();
    for (const tag of event.tags) {
      if (tag[0] === "a" && tag[1]) {
        const addr = tag[1];
        const [kindStr, addrPubkey] = addr.split(":");
        if (addrPubkey !== event.pubkey) continue;
        const kind = parseInt(kindStr, 10);
        const addrDTag = addr.split(":").slice(2).join(":");

        // Track this deletion so future re-deliveries from external relays are blocked
        dispatch(trackDeletedAddr({ addr, deletedAt: event.created_at }));

        if (kind === EVENT_KINDS.MUSIC_TRACK) {
          const track = state.music.tracks[addr];
          if (track && track.createdAt <= event.created_at) {
            deps.persistence.deleteAddressableEvent(kind, addrPubkey, addrDTag).catch(() => {});
            dispatch(removeTrack(addr));
          }
        } else if (kind === EVENT_KINDS.MUSIC_ALBUM) {
          const album = state.music.albums[addr];
          if (album && album.createdAt <= event.created_at) {
            deps.persistence.deleteAddressableEvent(kind, addrPubkey, addrDTag).catch(() => {});
            dispatch(removeAlbum(addr));
          }
        } else if (kind === EVENT_KINDS.MUSIC_PLAYLIST) {
          const playlist = state.music.playlists[addr];
          if (playlist && playlist.createdAt <= event.created_at) {
            deps.persistence.deleteAddressableEvent(kind, addrPubkey, addrDTag).catch(() => {});
            dispatch(removePlaylist(addr));
          }
        } else if (kind === EVENT_KINDS.MUSIC_TRACK_NOTES) {
          for (const [targetRef, anns] of Object.entries(state.music.annotations)) {
            const match = anns.find((a) => a.addressableId === addr);
            if (match && match.createdAt <= event.created_at) {
              dispatch(removeAnnotation({ targetRef, addressableId: addr }));
              break;
            }
          }
        }
      }
      // Handle "e" tag deletions (by event ID) — only if the referenced
      // event is authored by the deletion event's author.
      if (tag[0] === "e" && tag[1]) {
        // Reactions and poll votes aren't stored as entities — clear them
        // from their aggregates via the reverse index (no-op for other ids).
        dispatch(removeReactionByEventId({ eventId: tag[1], byPubkey: event.pubkey }));
        dispatch(removeVoteByEventId({ eventId: tag[1], byPubkey: event.pubkey }));
        const refEvent = state.events.entities[tag[1]];
        if (refEvent) {
          // Target known — apply NIP-09 directly: only the author may delete it.
          if (refEvent.pubkey === event.pubkey) {
            // Safety: don't let "e" tag deletions cascade to addressable music
            // events. Those must ONLY be deleted via "a" tags (handled above)
            // to properly respect the created_at supersedence rule.
            const isAddressableEvent = refEvent.kind >= 30000 && refEvent.kind < 40000;
            if (!isAddressableEvent) {
              deps.persistence.deleteEvent(tag[1]).catch(() => {});
            }
            if (refEvent.kind === EVENT_KINDS.CHAT_MESSAGE) {
              const refHTag = refEvent.tags.find((t) => t[0] === "h")?.[1];
              if (refHTag) {
                const refChannelTag = refEvent.tags.find((t) => t[0] === "channel")?.[1];
                const contextId = refChannelTag ? `${refHTag}:${refChannelTag}` : refHTag;
                dispatch(removeChatMessage({ contextId, eventId: tag[1] }));
              }
              dispatch(hideMessage(tag[1]));
              dispatch(removeEvent(tag[1]));
            } else if (refEvent.kind === EVENT_KINDS.POLL) {
              const refHTag = refEvent.tags.find((t) => t[0] === "h")?.[1];
              if (refHTag) {
                // Chat-scoped poll: remove from the chat timeline
                const refChannelTag = refEvent.tags.find((t) => t[0] === "channel")?.[1];
                const contextId = refChannelTag ? `${refHTag}:${refChannelTag}` : refHTag;
                dispatch(removeChatMessage({ contextId, eventId: tag[1] }));
                dispatch(hideMessage(tag[1]));
              } else {
                // Posts-side poll: remove from notes surfaces
                dispatch(removeNote({ pubkey: event.pubkey, eventId: tag[1] }));
              }
              dispatch(removeEvent(tag[1]));
              dispatch(trackDeletedNote(tag[1]));
              dispatch(removePoll(tag[1]));
            } else if (refEvent.kind === EVENT_KINDS.SHORT_TEXT) {
              dispatch(removeNote({ pubkey: event.pubkey, eventId: tag[1] }));
              dispatch(removeEvent(tag[1]));
              dispatch(trackDeletedNote(tag[1]));
            } else if (refEvent.kind === EVENT_KINDS.REPOST) {
              dispatch(removeRepost({ pubkey: event.pubkey, eventId: tag[1] }));
              dispatch(removeEvent(tag[1]));
              dispatch(trackDeletedNote(tag[1]));
            }
          }
          // else: a non-author asked to delete a known event — ignore it.
        } else {
          // Target not in the store yet. Record the request as PENDING instead of
          // suppressing on faith — it is applied only if the target, when it
          // arrives, was actually authored by this deleter (#21). Do NOT delete
          // from IndexedDB here.
          dispatch(trackPendingDeletion({ eventId: tag[1], deleter: event.pubkey }));
        }
      }
    }
    // Persist the deletion event itself so we can check on next startup
    deps.persistence.putEvent(event).catch(() => {});
  }

  return { indexDeletion };
}
