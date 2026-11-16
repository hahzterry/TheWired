import type { NostrEvent } from "../../../types/nostr";
import { EVENT_KINDS } from "../../../types/nostr";
import { indexChatMessage, indexReel, indexLongForm, indexLiveStream, indexNote, indexMusicTrack, indexMusicAlbum, indexReply, indexRepost, indexRepostByAuthor, indexQuote, indexEditedMessage } from "../../../store/slices/eventsSlice";
import { addReaction } from "../../../store/slices/reactionsSlice";
import { addZap } from "../../../store/slices/zapsSlice";
import { addPollVote } from "../../../store/slices/pollsSlice";
import { validateReceiptShape } from "../../lightning/zapReceipt";
import { notifyMusicUpdate } from "../../../features/music/savedVersionSync";
import { addTrack, indexTrackByArtist, indexTrackByAlbum, indexTrackByArtistName, indexAlbumByArtist, indexAlbumByArtistName, addAlbum, addPlaylist, addAnnotation, removeTrack, removeAlbum, recordMovedRelease, libraryReleaseMoved } from "../../../store/slices/musicSlice";
import { parseTrackEvent, parsePrivateTrackEvent } from "../../../features/music/trackParser";
import { parseAlbumEvent, parsePrivateAlbumEvent } from "../../../features/music/albumParser";
import { parsePlaylistEvent } from "../../../features/music/playlistParser";
import { parseAnnotationEvent } from "../../../features/music/annotationParser";
import { trackFeedTimestamp } from "../../../store/slices/feedSlice";
import { parseThreadRef, parseQuoteRef } from "../../../features/spaces/noteParser";
import { parseVoteEvent } from "../../../features/polls/pollParser";
import { forgetHeldProjectKey } from "../../../features/music/sharedKey/projectKeys";
import { addressOf, movedTargetOf } from "../../../features/music/sharedKey/members";
import { evaluateCollaboratorNotification } from "../notificationEvaluator";
import { addEmojiSet, setUserEmojis, setSpaceEmojiSets } from "../../../store/slices/emojiSlice";
import { parseEmojiSetEvent, parseUserEmojiListEvent } from "../../../features/emoji/emojiSetParser";
import { scheduleMemberSync } from "../../../store/thunks/spaceMembers";
import { parseSpaceConfigChanged, scheduleSpaceConfigSync } from "../../../store/thunks/spaceConfigSync";
import {
  applyNativeGroupEvent,
  applyNativeLayoutEvent,
  applyNativeRelaySetEvent,
} from "../../../features/spaces/nip29SpaceSync";
import type { PipelineContext } from "./types";
import type { Batching } from "./batching";

/** The handlers `indexEvent` hands off to (each lives in its own file). */
export interface IndexHandlers {
  /** Author-scoped feeds; runs after the switch for every event (`spaceFeeds.ts`). */
  indexEventIntoSpaceFeeds(event: NostrEvent): void;
  /** kind:5 (`deletionIndex.ts`). */
  indexDeletion(event: NostrEvent): void;
  /** kind:9005 (`modDeleteIndex.ts`). */
  indexModDelete(event: NostrEvent, relayUrl: string): void;
}

/**
 * `indexEvent`: the kind switch. Every kind the app indexes has a `case` here;
 * a kind without one is stored as an entity and nothing else. To support a new
 * kind, add its case to the switch below.
 *
 * The music cases stay inline: they await a decrypt for private releases, and
 * a public release must still be indexed without yielding.
 *
 * The body is the code as it stood inside `createEventPipeline`.
 */
export function createEventIndexer(ctx: PipelineContext, batching: Batching, handlers: IndexHandlers) {
  const { dispatch, getState } = ctx;
  const { emit, flushEventPipeline } = batching;
  const { indexEventIntoSpaceFeeds, indexDeletion, indexModDelete } = handlers;

  /** Index an h-tagged event into the per-channel chat timeline (kind:9 messages
   *  and kind:1068 polls share this so polls interleave chronologically). */
  function indexIntoChatChannel(event: NostrEvent, hTag: string): void {
    const channelTag = event.tags.find((t) => t[0] === "channel")?.[1];

    if (channelTag) {
      // New-style: explicit channel tag → index per-channel
      const indexKey = `${hTag}:${channelTag}`;
      emit(indexChatMessage({ groupId: indexKey, eventId: event.id }));
      emit(trackFeedTimestamp({ contextId: indexKey, createdAt: event.created_at }));
    } else {
      // Legacy: no channel tag → route to default chat channel if known
      const state = getState();
      const spaceChannels = state.spaces.channels[hTag];
      const defaultChat = spaceChannels?.find((c) => c.type === "chat" && c.isDefault)
        ?? spaceChannels?.find((c) => c.type === "chat");

      if (defaultChat) {
        const indexKey = `${hTag}:${defaultChat.id}`;
        emit(indexChatMessage({ groupId: indexKey, eventId: event.id }));
        emit(trackFeedTimestamp({ contextId: indexKey, createdAt: event.created_at }));
      } else {
        // Channels not loaded yet — fall back to space-level indexing
        emit(indexChatMessage({ groupId: hTag, eventId: event.id }));
        emit(trackFeedTimestamp({ contextId: hTag, createdAt: event.created_at }));
      }
    }
  }

  async function indexEvent(event: NostrEvent, relayUrl: string): Promise<void> {
    const hTag = event.tags.find((t) => t[0] === "h")?.[1];

    switch (event.kind) {
      case EVENT_KINDS.SHORT_TEXT: {
        emit(indexNote({ pubkey: event.pubkey, eventId: event.id }));
        // Index as reply if it has thread references
        const threadRef = parseThreadRef(event);
        if (threadRef.rootId) {
          emit(indexReply({ parentEventId: threadRef.rootId, eventId: event.id }));
          if (threadRef.replyId && threadRef.replyId !== threadRef.rootId) {
            emit(indexReply({ parentEventId: threadRef.replyId, eventId: event.id }));
          }
        }
        // Index as quote if it has a "q" tag
        const quoteRef = parseQuoteRef(event);
        if (quoteRef) {
          emit(indexQuote({ targetEventId: quoteRef.eventId, eventId: event.id }));
        }
        break;
      }
      case EVENT_KINDS.REACTION: {
        // NIP-25: last "e" tag is the target event. Fold into the reaction
        // aggregate (count + emoji + who reacted) rather than storing the event.
        const lastETag = [...event.tags].reverse().find((t) => t[0] === "e");
        if (lastETag?.[1]) {
          emit(addReaction({
            targetEventId: lastETag[1],
            reactor: event.pubkey,
            content: event.content,
            eventId: event.id,
          }));
        }
        break;
      }
      case EVENT_KINDS.REPOST: {
        const eTag = event.tags.find((t) => t[0] === "e");
        if (eTag?.[1]) {
          emit(indexRepost({ targetEventId: eTag[1], eventId: event.id }));
        }
        emit(indexRepostByAuthor({ pubkey: event.pubkey, eventId: event.id }));
        break;
      }
      case EVENT_KINDS.ZAP_RECEIPT: {
        // NIP-57 kind:9735 receipt. Fold the amount into the zap aggregate, keyed
        // by the zapped event's id (the receipt's `e` tag). Client-agnostic: any
        // client's zap shows up. We don't keep the full receipt event.
        // Anyone can publish a 9735 with an `e` tag, so a receipt only counts
        // when its embedded kind:9734 request is consistent with it and with the
        // target (validateReceiptShape); when the zapped note is already in the
        // store its author must be the receipt's `p`.
        const targetId = event.tags.find((t) => t[0] === "e")?.[1];
        if (targetId) {
          const recipientPubkey = getState().events.entities[targetId]?.pubkey;
          const ok = validateReceiptShape(event, { targetEventId: targetId, recipientPubkey });
          if (ok) {
            emit(addZap({
              targetEventId: targetId,
              receiptId: event.id,
              msat: ok.msat,
              zapper: ok.zapper,
              comment: ok.comment,
              createdAt: event.created_at,
            }));
          }
        }
        break;
      }
      case EVENT_KINDS.CHAT_MESSAGE: {
        // Check if this is an edit event (has ["e", ..., "edit"] tag)
        const editTag = event.tags.find((t) => t[0] === "e" && t[3] === "edit");
        if (editTag?.[1]) {
          const originalId = editTag[1];
          // Apply buffered adds so a same-burst original message resolves.
          flushEventPipeline();
          const state = getState();
          const originalEvent = state.events.entities[originalId];
          // Only accept edits from the same author
          if (originalEvent && originalEvent.pubkey === event.pubkey) {
            dispatch(indexEditedMessage({ originalId, editEventId: event.id }));
            // Store the edit event but do NOT add to chatMessages index
          }
          break;
        }

        if (hTag) {
          indexIntoChatChannel(event, hTag);
        }
        break;
      }
      case EVENT_KINDS.POLL: {
        // NIP-88 poll. Space-scoped (h tag) → chat timeline, interleaved with
        // kind:9 messages; bare → notes surfaces (profile + space feeds).
        if (hTag) {
          indexIntoChatChannel(event, hTag);
        } else {
          emit(indexNote({ pubkey: event.pubkey, eventId: event.id }));
        }
        break;
      }
      case EVENT_KINDS.POLL_RESPONSE: {
        // NIP-88 vote. Folded into the polls aggregate (latest per pubkey wins);
        // the event itself is never stored (excluded from addEvent above).
        const vote = parseVoteEvent(event);
        if (vote) {
          emit(addPollVote(vote));
        }
        break;
      }
      case EVENT_KINDS.VIDEO_VERTICAL:
      case EVENT_KINDS.VIDEO_VERTICAL_ADDR: {
        const contextId = hTag ?? "global";
        emit(indexReel({ contextId, eventId: event.id }));
        break;
      }
      case EVENT_KINDS.LONG_FORM: {
        const contextId = hTag ?? "global";
        emit(indexLongForm({ contextId, eventId: event.id }));
        break;
      }
      case EVENT_KINDS.LIVE_STREAM: {
        const contextId = hTag ?? "global";
        emit(indexLiveStream({ contextId, eventId: event.id }));
        break;
      }
      case EVENT_KINDS.MUSIC_TRACK: {
        const movedTo = movedTargetOf(event);
        if (movedTo) {
          handleMovedStub(event, movedTo);
          break;
        }
        emit(indexMusicTrack({ contextId: hTag ?? "global", eventId: event.id }));

        // Helper to dispatch track into Redux + artist/collaborator indices
        const dispatchTrack = (track: import("../../../types/music").MusicTrack) => {
          dispatch(addTrack(track));
          if (track.artistPubkeys.length > 0) {
            for (const pk of track.artistPubkeys) {
              dispatch(indexTrackByArtist({ pubkey: pk, addressableId: track.addressableId }));
            }
          } else if (track.artist && track.artist !== event.pubkey) {
            dispatch(indexTrackByArtistName({ normalizedName: track.artist.toLowerCase().trim(), addressableId: track.addressableId }));
          } else {
            dispatch(indexTrackByArtist({ pubkey: event.pubkey, addressableId: track.addressableId }));
          }
          for (const fp of track.featuredArtists) {
            dispatch(indexTrackByArtist({ pubkey: fp, addressableId: track.addressableId }));
          }
          // Index by collaborator pubkeys so they can discover via selectMyCollaborations
          for (const cp of track.collaborators) {
            dispatch(indexTrackByArtist({ pubkey: cp, addressableId: track.addressableId }));
          }
          if (track.albumRef) {
            dispatch(indexTrackByAlbum({ albumAddrId: track.albumRef, trackAddrId: track.addressableId }));
          }
          // A newer version of a saved track just landed → "updated" notification
          // (no-op unless the user saved it and this is strictly newer).
          notifyMusicUpdate(track.addressableId);
        };

        const isPrivate = event.tags.some(
          (t) => t[0] === "visibility" && (t[1] === "private" || t[1] === "unlisted"),
        );

        if (isPrivate && event.content) {
          // Private track with encrypted content — attempt async decryption
          const myPubkey = getState().identity.pubkey;
          if (myPubkey) {
            // Await the decrypt so the track is in Redux before signAndPublish returns
            try {
              const track = await parsePrivateTrackEvent(event, myPubkey);
              if (track) {
                dispatchTrack(track);
                // Notify collaborator if this is not our own event
                if (event.pubkey !== myPubkey && !isHeldKey(event.pubkey) && track.collaborators.includes(myPubkey)) {
                  evaluateCollaboratorNotification(event, track.title, track.addressableId);
                }
              }
            } catch {
              // Can't decrypt = not authorized, silently skip
            }
          }
        } else {
          // Public, space, or legacy private (no encrypted content)
          const track = parseTrackEvent(event);
          dispatchTrack(track);
          // Notify if we're tagged as collaborator/featured on someone else's track
          const myPubkey = getState().identity.pubkey;
          if (myPubkey && event.pubkey !== myPubkey && !isHeldKey(event.pubkey)) {
            const isTagged = track.collaborators.includes(myPubkey) ||
              track.featuredArtists.includes(myPubkey);
            if (isTagged) {
              evaluateCollaboratorNotification(event, track.title, track.addressableId);
            }
          }
        }
        break;
      }
      case EVENT_KINDS.MUSIC_ALBUM: {
        const movedTo = movedTargetOf(event);
        if (movedTo) {
          handleMovedStub(event, movedTo);
          break;
        }
        emit(indexMusicAlbum({ contextId: hTag ?? "global", eventId: event.id }));

        const dispatchAlbum = (album: import("../../../types/music").MusicAlbum) => {
          dispatch(addAlbum(album));
          if (album.artistPubkeys.length > 0) {
            for (const pk of album.artistPubkeys) {
              dispatch(indexAlbumByArtist({ pubkey: pk, addressableId: album.addressableId }));
            }
          } else if (album.artist && album.artist !== event.pubkey) {
            dispatch(indexAlbumByArtistName({ normalizedName: album.artist.toLowerCase().trim(), addressableId: album.addressableId }));
          } else {
            dispatch(indexAlbumByArtist({ pubkey: event.pubkey, addressableId: album.addressableId }));
          }
          for (const fp of album.featuredArtists) {
            dispatch(indexAlbumByArtist({ pubkey: fp, addressableId: album.addressableId }));
          }
          // Index by collaborator pubkeys
          for (const cp of album.collaborators) {
            dispatch(indexAlbumByArtist({ pubkey: cp, addressableId: album.addressableId }));
          }
          // Same for a saved project
          notifyMusicUpdate(album.addressableId);
        };

        const isPrivateAlbum = event.tags.some(
          (t) => t[0] === "visibility" && (t[1] === "private" || t[1] === "unlisted"),
        );

        if (isPrivateAlbum && event.content) {
          const myPubkey = getState().identity.pubkey;
          if (myPubkey) {
            try {
              const album = await parsePrivateAlbumEvent(event, myPubkey);
              if (album) {
                dispatchAlbum(album);
                if (event.pubkey !== myPubkey && !isHeldKey(event.pubkey) && album.collaborators.includes(myPubkey)) {
                  evaluateCollaboratorNotification(event, album.title, album.addressableId);
                }
              }
            } catch {
              // Can't decrypt = not authorized
            }
          }
        } else {
          const album = parseAlbumEvent(event);
          dispatchAlbum(album);
          // Notify if we're tagged as collaborator/featured on someone else's album
          const myPubkey = getState().identity.pubkey;
          if (myPubkey && event.pubkey !== myPubkey && !isHeldKey(event.pubkey)) {
            const isTagged = album.collaborators.includes(myPubkey) ||
              album.featuredArtists.includes(myPubkey);
            if (isTagged) {
              evaluateCollaboratorNotification(event, album.title, album.addressableId);
            }
          }
        }
        break;
      }
      case EVENT_KINDS.MUSIC_PLAYLIST: {
        const playlist = parsePlaylistEvent(event);
        dispatch(addPlaylist(playlist));
        break;
      }
      case EVENT_KINDS.MUSIC_TRACK_NOTES: {
        const annotation = parseAnnotationEvent(event);
        if (annotation) {
          dispatch(addAnnotation(annotation));
        }
        break;
      }
      case EVENT_KINDS.DELETION: {
        indexDeletion(event);
        break;
      }
      case EVENT_KINDS.EMOJI_SET: {
        // NIP-30: Custom emoji set (kind:30030)
        const emojiSet = parseEmojiSetEvent(event);
        dispatch(addEmojiSet(emojiSet));
        // Track space-scoped emoji sets
        const emojiHTag = event.tags.find((t) => t[0] === "h")?.[1];
        if (emojiHTag) {
          const state = getState();
          const existing = state.emoji.spaceEmojiSets[emojiHTag] ?? [];
          if (!existing.includes(emojiSet.addressableId)) {
            dispatch(setSpaceEmojiSets({ spaceId: emojiHTag, setIds: [...existing, emojiSet.addressableId] }));
          }
        }
        break;
      }
      case EVENT_KINDS.USER_EMOJI_LIST: {
        // NIP-51: User emoji list (kind:10030)
        const myPubkey = getState().identity.pubkey;
        if (event.pubkey === myPubkey) {
          const { emojis } = parseUserEmojiListEvent(event);
          dispatch(setUserEmojis(emojis));
        }
        break;
      }
      case EVENT_KINDS.APP_SPECIFIC_DATA: {
        // kind:30078 overlays for native spaces, each guarded by its d-tag prefix
        // so unrelated 30078 uses (DM read-state) pass through:
        //   wired:relays:<id>  — mirror relay set (M9)
        //   wired:/obelisk:layout — channel layout (M4)
        if (!applyNativeRelaySetEvent(event)) {
          applyNativeLayoutEvent(event);
        }
        break;
      }
      case EVENT_KINDS.GROUP_METADATA:
      case EVENT_KINDS.GROUP_ADMINS: {
        // Relay-authoritative NIP-29 state (39000 metadata / 39001 admins). Applied
        // only to nip29-native spaces; a no-op for platform/A-lite (backend owns those).
        applyNativeGroupEvent(event);
        break;
      }
      case EVENT_KINDS.GROUP_MEMBERS: {
        // NIP-29 kind:39002 (replaceable group members list). Native spaces
        // synthesize members directly from the relay event; platform / A-lite
        // spaces stay backend-authoritative and trigger a debounced refetch.
        if (!applyNativeGroupEvent(event)) {
          const dTag = event.tags.find((t) => t[0] === "d")?.[1];
          if (dTag && getState().spaces.list.some((s) => s.id === dTag)) {
            scheduleMemberSync(dTag, dispatch);
          }
        }
        break;
      }
      case EVENT_KINDS.SPACE_CONFIG_CHANGED: {
        // Backend nudge: "this platform space's <what> changed". No
        // data rides on it — the matching REST refetch is the response, debounced
        // per space. Unknown spaces are ignored, so a stranger's nudge is free.
        const nudge = parseSpaceConfigChanged(event);
        if (nudge && getState().spaces.list.some((s) => s.id === nudge.spaceId)) {
          scheduleSpaceConfigSync(nudge.spaceId, nudge.changes, dispatch);
        }
        break;
      }
      case EVENT_KINDS.MOD_DELETE_EVENT: {
        indexModDelete(event, relayUrl);
        break;
      }
    }

    // Index into active space feeds
    indexEventIntoSpaceFeeds(event);
  }

  /** A release signed by a shared-project key this device holds is "mine". */
  function isHeldKey(pubkey: string): boolean {
    return pubkey in (getState().music.heldProjectKeys ?? {});
  }

  /** A rotation stub (`moved` tag) replaces the release at its address and is
   *  never shelved or played: drop the old copy, remember the redirect, and
   *  forget the stub author's key if this device holds it. A stub older than
   *  the release we have (someone republished over it) is ignored. */
  function handleMovedStub(event: NostrEvent, movedTo: string): void {
    const from = addressOf(event);
    const music = getState().music;
    const current = event.kind === EVENT_KINDS.MUSIC_TRACK ? music.tracks[from] : music.albums[from];
    if (current && current.createdAt > event.created_at) return;
    // The listener's saved/favorited entry follows the release to its new
    // address (keeping its place) before the old copy is dropped.
    dispatch(libraryReleaseMoved({ from, to: movedTo }));
    dispatch(event.kind === EVENT_KINDS.MUSIC_TRACK ? removeTrack(from) : removeAlbum(from));
    dispatch(recordMovedRelease({ from, to: movedTo, at: event.created_at }));
    if (isHeldKey(event.pubkey)) forgetHeldProjectKey(event.pubkey).catch(() => {});
  }

  return { indexEvent };
}
