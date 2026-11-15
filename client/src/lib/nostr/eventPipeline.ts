import type { NostrEvent } from "../../types/nostr";
import { EVENT_KINDS } from "../../types/nostr";
import { EventDeduplicator } from "./dedup";
import { registerForgetSeen } from "./forgetSeen";
import { clearPendingDeletion } from "../../store/slices/eventsSlice";
import { isValidEventStructure } from "./validation";
import { verifyBridge } from "./verifyWorkerBridge";
import { store } from "../../store";
import type { AppDispatch } from "../../store";
import { putEvent, deleteEvent, deleteAddressableEvent } from "../db/eventStore";
import { addEvent, indexChatMessage, indexReel, indexLongForm, indexLiveStream, indexNote, indexMusicTrack, indexMusicAlbum, indexReply, indexRepost, indexRepostByAuthor, indexQuote, hideMessage, trackDeletedNote, indexEditedMessage } from "../../store/slices/eventsSlice";
import { addReaction } from "../../store/slices/reactionsSlice";
import { addZap } from "../../store/slices/zapsSlice";
import { addPollVote } from "../../store/slices/pollsSlice";
import { validateReceiptShape } from "../lightning/zapReceipt";
import { notifyMusicUpdate } from "../../features/music/savedVersionSync";
import { addTrack, indexTrackByArtist, indexTrackByAlbum, indexTrackByArtistName, indexAlbumByArtist, indexAlbumByArtistName, addAlbum, addPlaylist, addAnnotation, removeTrack, removeAlbum, recordMovedRelease, libraryReleaseMoved } from "../../store/slices/musicSlice";
import { parseTrackEvent, parsePrivateTrackEvent } from "../../features/music/trackParser";
import { parseAlbumEvent, parsePrivateAlbumEvent } from "../../features/music/albumParser";
import { parsePlaylistEvent } from "../../features/music/playlistParser";
import { parseAnnotationEvent } from "../../features/music/annotationParser";
import { incrementEventCount } from "../../store/slices/relaysSlice";
import { trackFeedTimestamp } from "../../store/slices/feedSlice";
import { parseThreadRef, parseQuoteRef } from "../../features/spaces/noteParser";
import { parseVoteEvent } from "../../features/polls/pollParser";
import { profileCache } from "./profileCache";
import { forgetHeldProjectKey } from "../../features/music/sharedKey/projectKeys";
import { addressOf, movedTargetOf } from "../../features/music/sharedKey/members";
import { decryptQueue } from "./decryptQueue";
import { evaluateNotification, evaluateCollaboratorNotification } from "./notificationEvaluator";
import { addEmojiSet, setUserEmojis, setSpaceEmojiSets } from "../../store/slices/emojiSlice";
import { parseEmojiSetEvent, parseUserEmojiListEvent } from "../../features/emoji/emojiSetParser";
import { scheduleMemberSync } from "../../store/thunks/spaceMembers";
import { parseSpaceConfigChanged, scheduleSpaceConfigSync } from "../../store/thunks/spaceConfigSync";
import {
  applyNativeGroupEvent,
  applyNativeLayoutEvent,
  applyNativeRelaySetEvent,
} from "../../features/spaces/nip29SpaceSync";
import { createLogger, shortKey, shortRelay } from "../debug/logger";
import type { EventPipelineDeps, PipelineContext } from "./pipeline/types";
import { computeSweep } from "./pipeline/sweep";
import { createBatching } from "./pipeline/batching";
import { createSpaceFeedIndexer } from "./pipeline/spaceFeeds";
import { createCallWrapHandlers } from "./pipeline/callWraps";
import { createFriendWrapHandlers } from "./pipeline/friendWraps";
import { createGiftWrapHandler } from "./pipeline/giftWrapHandler";
import { createDeletionIndexer } from "./pipeline/deletionIndex";
import { createModDeleteIndexer } from "./pipeline/modDeleteIndex";

export type { EventPipelineDeps };
export { computeSweep };

const log = createLogger("pipeline");
const latencyLog = createLogger("latency");

/** Gated per-message receive-latency probe (enable with `wiredDebug.enable("latency")`).
 *  Splits the delay into transit (sender→here) and pipeline (verify+dispatch here),
 *  tagged by the delivering relay — so a self-hosted/loopback group can be compared
 *  against a platform space to localize where time goes. `transit` uses the event's
 *  second-granularity `created_at`, so it carries ±1s noise + any clock skew; the
 *  `pipeline` figure is monotonic and exact. */
function logChatLatency(event: NostrEvent, relayUrl: string, receivedAt: number): void {
  const transit = receivedAt - event.created_at * 1000;
  const pipeline = Date.now() - receivedAt;
  latencyLog.info(
    `kind:9 ${event.id.slice(0, 8)} via ${shortRelay(relayUrl)} — transit ~${transit}ms · pipeline ${pipeline}ms`,
  );
}


// ── Dependency inversion (Phase 0, guide 01 §4) ──────────────────────────────
// The pipeline's logic is pure and portable; its platform couplings (Redux
// store, Web Worker verifier, IndexedDB persistence, profile cache, decrypt
// queue) are injected here. The desktop wires its existing singletons into a
// default instance below — behavior-identical to the old module-level form.

export type EventPipeline = ReturnType<typeof createEventPipeline>;

export function createEventPipeline(deps: EventPipelineDeps) {
  const { dispatch, getState } = deps;

const dedup = new EventDeduplicator();

// Cached Set for space author lookups (O(1) instead of O(n) per check)
const authorSetCache = new Map<string, { set: Set<string>; fingerprint: string }>();
const ctx: PipelineContext = { deps, dispatch, getState, dedup, authorSetCache };

const batching = createBatching(ctx);
const { emit, isBurstSource, scheduleFlush, flushEventPipeline, resetEventPipelineCaches, forgetSeenEvents, __sweepForTest } = batching;
const { indexEventIntoSpaceFeeds } = createSpaceFeedIndexer(ctx, batching);
const { handleCallInviteWrap, handleCallDeclineWrap, handleCallMissedWrap } = createCallWrapHandlers(ctx);
const { handleFriendRequestWrap, handleFriendAcceptWrap, handleFriendRemoveWrap } = createFriendWrapHandlers(ctx);
const { indexDeletion } = createDeletionIndexer(ctx, batching);
const { indexModDelete } = createModDeleteIndexer(ctx, batching);
const { handleGiftWrap } = createGiftWrapHandler(ctx, {
  handleFriendRequestWrap,
  handleFriendAcceptWrap,
  handleFriendRemoveWrap,
  handleCallInviteWrap,
  handleCallDeclineWrap,
  handleCallMissedWrap,
});

/**
 * Main event processing pipeline:
 * 1. Structural validation
 * 2. Dedup check (LRU)
 * 3. Signature verification (Web Worker)
 * 4. Dispatch to Redux + index
 */
async function processIncomingEvent(
  event: unknown,
  relayUrl: string,
): Promise<void> {
  // Wall-clock arrival at the pipeline — used by the gated "latency" probe to
  // split transit (sender→here) from pipeline (verify+dispatch) per relay.
  const receivedAt = Date.now();

  // Step 1: Structural validation (fast, sync)
  if (!isValidEventStructure(event)) {
    if ((event as { kind?: number })?.kind === 9) {
      console.warn("[pipeline] kind:9 dropped — invalid structure", event);
    }
    return;
  }

  // Step 2: Dedup
  if (dedup.isDuplicate(event.id)) {
    if (event.kind === EVENT_KINDS.METADATA) {
      log.debug(`kind:0 ${shortKey(event.pubkey)} dropped as duplicate (already processed) from ${shortRelay(relayUrl)}`);
    }
    return;
  }
  dedup.markSeen(event.id);

  // Step 3: Signature verification (Web Worker, async)
  try {
    const valid = await deps.verifier.verify(event);
    if (!valid) {
      if (event.kind === 9) console.warn("[pipeline] kind:9 verify FAIL", event.id.slice(0, 8));
      if (event.kind === EVENT_KINDS.METADATA) log.warn(`kind:0 ${shortKey(event.pubkey)} verify FAIL from ${shortRelay(relayUrl)} — profile rejected`);
      // Unmark so the event can be retried from another relay
      dedup.unmarkSeen(event.id);
      return;
    }
  } catch (err) {
    if (event.kind === 9) console.warn("[pipeline] kind:9 verify ERROR", err);
    if (event.kind === EVENT_KINDS.METADATA) log.warn(`kind:0 ${shortKey(event.pubkey)} verify ERROR from ${shortRelay(relayUrl)}`, err);
    // Verification timeout or worker error — unmark so retry is possible
    dedup.unmarkSeen(event.id);
    return;
  }

  // Step 4: Handle gift wraps specially (don't add to general event store).
  // Route the decrypt through a concurrency-limited queue so a cold-start backlog
  // can't saturate the signer / flood a NIP-46 bunker (#4/#25). On overflow, drop
  // and unmark so a later redelivery retries.
  if (event.kind === EVENT_KINDS.GIFT_WRAP) {
    dispatch(incrementEventCount(relayUrl));
    if (!deps.decryptQueue.submit(event)) {
      dedup.unmarkSeen(event.id);
    }
    return;
  }

  // Step 3b: Reject re-delivered deleted notes/reposts/polls
  if (
    (event.kind === EVENT_KINDS.SHORT_TEXT || event.kind === EVENT_KINDS.REPOST ||
      event.kind === EVENT_KINDS.POLL) &&
    getState().events.deletedNoteIds[event.id]
  ) {
    return;
  }

  // Step 3c: Reject re-delivered deleted addressable events (music tracks/albums/etc.)
  // External relays may not process "a" tag deletions, so they re-deliver events
  // that our relay has already deleted. Check against persisted deletion timestamps.
  if (event.kind >= 30000 && event.kind < 40000) {
    const dTag = event.tags.find((t: string[]) => t[0] === "d")?.[1];
    if (dTag !== undefined) {
      const addr = `${event.kind}:${event.pubkey}:${dTag}`;
      const deletedAt = getState().events.deletedAddrIds[addr];
      if (deletedAt !== undefined && event.created_at <= deletedAt) {
        return;
      }
    }
  }

  // Step 3d: Resolve a pending kind:5 deletion now that the target has arrived.
  // A deletion is only honored if one of the requesters actually authored this
  // event (#21) — so a third party that published a kind:5 for an id it doesn't
  // own can no longer suppress the real note when it shows up.
  const pendingDeleters = getState().events.pendingDeletions[event.id];
  if (pendingDeleters && pendingDeleters.length > 0) {
    const authorized = pendingDeleters.includes(event.pubkey);
    dispatch(clearPendingDeletion(event.id));
    if (authorized && (event.kind === EVENT_KINDS.SHORT_TEXT || event.kind === EVENT_KINDS.REPOST)) {
      dispatch(trackDeletedNote(event.id));
      deps.persistence.deleteEvent(event.id).catch(() => {});
      return;
    }
    if (authorized && event.kind === EVENT_KINDS.CHAT_MESSAGE) {
      dispatch(hideMessage(event.id));
      deps.persistence.deleteEvent(event.id).catch(() => {});
      return;
    }
    // An un-react (kind:5 for a kind:7) that arrived before the reaction it
    // retracts — relays don't order across kinds. Drop the reaction instead of
    // folding it into the aggregate, or the pill would reappear.
    if (authorized && event.kind === EVENT_KINDS.REACTION) {
      return;
    }
    // Otherwise (unauthorized deleter, or a kind we don't pre-suppress) fall
    // through and index the event normally.
  }

  // Step 4: Dispatch to store (buffered on the burst path — see flushEventPipeline).
  // Reactions (kind:7) and zap receipts (kind:9735) are NOT stored as full
  // events — they fold into their aggregate slices in indexEvent, saving memory
  // on hot notes.
  if (
    event.kind !== EVENT_KINDS.REACTION &&
    event.kind !== EVENT_KINDS.ZAP_RECEIPT &&
    event.kind !== EVENT_KINDS.POLL_RESPONSE
  ) {
    emit(addEvent(event));
  }
  emit(incrementEventCount(relayUrl));

  // Gated receive-latency probe for group chat (kind:9 with an `h` tag), so a
  // self-hosted/loopback group's delivery can be compared against a platform space.
  if (event.kind === EVENT_KINDS.CHAT_MESSAGE && event.tags.some((t) => t[0] === "h")) {
    logChatLatency(event, relayUrl, receivedAt);
  }

  // Step 4b: Wire kind:0 events into the profile cache
  if (event.kind === EVENT_KINDS.METADATA) {
    log.debug(`kind:0 ${shortKey(event.pubkey)} reached pipeline from ${shortRelay(relayUrl)} → handing to profile cache`);
    deps.profileCache.handleProfileEvent(event, relayUrl);
  }

  // Step 4c: Persist addressable events to IndexedDB (music, longform, etc.)
  // so they survive page refresh
  if (event.kind >= 30000 && event.kind < 40000) {
    deps.persistence.putEvent(event).catch(() => {/* best-effort persistence */});
  }

  // Step 5: Index by kind (may await NIP-44 decryption for private music events)
  await indexEvent(event, relayUrl);

  // Step 6: Evaluate for notifications (unread badges, toasts)
  evaluateNotification(event);

  // Step 7: Flush. Synthetic sources (optimistic sends, resolvers) flush now so
  // awaiting callers read fresh state; real-relay bursts coalesce on a timer.
  if (isBurstSource(relayUrl)) scheduleFlush(event.kind);
  else flushEventPipeline();
}

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
      const dispatchTrack = (track: import("../../types/music").MusicTrack) => {
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

      const dispatchAlbum = (album: import("../../types/music").MusicAlbum) => {
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

// The decrypt queue defers gift-wrap handling with bounded concurrency; wire the
// real handler once (function declaration is hoisted, so this is safe here).
deps.decryptQueue.setHandler(handleGiftWrap);

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


  return {
    processIncomingEvent,
    flushEventPipeline,
    resetEventPipelineCaches,
    forgetSeenEvents,
    __sweepForTest,
  };
}

// ── Default desktop instance ─────────────────────────────────────────────────
// Wired with the app's existing singletons. The dispatch/getState arrows are
// deliberate: they resolve `store.dispatch` at call time, so account-switch
// store resets and test spies keep working.
const defaultPipeline = createEventPipeline({
  dispatch: ((action: Parameters<AppDispatch>[0]) => store.dispatch(action)) as AppDispatch,
  getState: () => store.getState(),
  verifier: verifyBridge,
  persistence: { putEvent, deleteEvent, deleteAddressableEvent },
  profileCache,
  decryptQueue,
});

/**
 * Main event processing pipeline (default desktop instance):
 * 1. Structural validation
 * 2. Dedup check (LRU)
 * 3. Signature verification (Web Worker)
 * 4. Dispatch to Redux + index
 */
export const processIncomingEvent = defaultPipeline.processIncomingEvent;

/** Apply all buffered burst-path ops in one batch — see createEventPipeline. */
export const flushEventPipeline = defaultPipeline.flushEventPipeline;

/** Clear all pipeline caches (used during account switch). */
export const resetEventPipelineCaches = defaultPipeline.resetEventPipelineCaches;

// Features drop events on purpose (e.g. a space's music when the viewer
// leaves it) and need them deliverable again; they reach the dedup LRU through
// the registry rather than importing this module back.
registerForgetSeen(defaultPipeline.forgetSeenEvents);

/** Test-only: run the sweep with explicit caps (so a test needn't seed 20k events). */
export const __sweepForTest = defaultPipeline.__sweepForTest;
