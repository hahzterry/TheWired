import type { NostrEvent } from "../../types/nostr";
import { EVENT_KINDS } from "../../types/nostr";
import { EventDeduplicator } from "./dedup";
import { registerForgetSeen } from "./forgetSeen";
import { inModGroup, verifySpaceModAuthority } from "./mutationAuthority";
import { trackPendingDeletion, clearPendingDeletion } from "../../store/slices/eventsSlice";
import { isValidEventStructure } from "./validation";
import { verifyBridge } from "./verifyWorkerBridge";
import { store } from "../../store";
import type { AppDispatch } from "../../store";
import { putEvent, deleteEvent, deleteAddressableEvent } from "../db/eventStore";
import { addEvent, indexChatMessage, indexReel, indexLongForm, indexLiveStream, indexNote, indexMusicTrack, indexMusicAlbum, indexReply, indexRepost, indexRepostByAuthor, indexQuote, removeChatMessage, hideMessage, removeEvent, removeNote, removeRepost, trackDeletedNote, trackDeletedAddr, indexEditedMessage } from "../../store/slices/eventsSlice";
import { addReaction, removeReactionByEventId } from "../../store/slices/reactionsSlice";
import { addZap } from "../../store/slices/zapsSlice";
import { addPollVote, removeVoteByEventId, removePoll } from "../../store/slices/pollsSlice";
import { validateReceiptShape } from "../lightning/zapReceipt";
import { notifyMusicUpdate } from "../../features/music/savedVersionSync";
import { addTrack, indexTrackByArtist, indexTrackByAlbum, indexTrackByArtistName, indexAlbumByArtist, indexAlbumByArtistName, addAlbum, addPlaylist, addAnnotation, removeAnnotation, removeTrack, removeAlbum, removePlaylist, recordMovedRelease, libraryReleaseMoved } from "../../store/slices/musicSlice";
import { addDMMessage, editDMMessage, remoteDeleteDMMessage, reactDMMessage, removeDMReaction, setTyping, applyReceipt, markDMWrapProcessed } from "../../store/slices/dmSlice";
import { parseDMWire } from "@ishtarservices/core";
import { DM_EXPIRATION_SECONDS } from "@ishtarservices/shared-types";
import { queueDeliveredReceipt } from "./dmSignals";
import { parseTrackEvent, parsePrivateTrackEvent } from "../../features/music/trackParser";
import { parseAlbumEvent, parsePrivateAlbumEvent } from "../../features/music/albumParser";
import { parsePlaylistEvent } from "../../features/music/playlistParser";
import { parseAnnotationEvent } from "../../features/music/annotationParser";
import { incrementEventCount } from "../../store/slices/relaysSlice";
import { trackFeedTimestamp } from "../../store/slices/feedSlice";
import { parseThreadRef, parseQuoteRef } from "../../features/spaces/noteParser";
import { parseVoteEvent } from "../../features/polls/pollParser";
import { profileCache } from "./profileCache";
import { unwrapGiftWrap, type UnwrappedDM } from "./giftWrap";
import { GiftWrapRejectedError } from "@ishtarservices/core";
import { GIFT_WRAP_ACCEPT_KINDS, KIND_DM_PROJECT_KEY, parseProjectKeyDM } from "../../features/music/sharedKey/projectKeyDM";
import { forgetHeldProjectKey, receiveProjectKey } from "../../features/music/sharedKey/projectKeys";
import { isSecretPersistEnabled } from "./secretStore";
import { addressOf, movedTargetOf } from "../../features/music/sharedKey/members";
import { decryptQueue } from "./decryptQueue";
import { evaluateNotification, evaluateDMNotification, evaluateCollaboratorNotification } from "./notificationEvaluator";
import { deliverMediaKey } from "../webrtc/e2ee/mediaKeyInbox";
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
      // NIP-29 kind:9005: moderator delete — admin removes a message from the group.
      const groupId = event.tags.find((t) => t[0] === "h")?.[1];
      if (!groupId) break;

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
        break;
      }
      if (verdict === "defer-host-relay") {
        // A platform space's role-holding moderator is vouched for only by the
        // host relay's delivery. Leave the id unseen so that copy is processed
        // even when a mirror delivered this one first.
        dedup.unmarkSeen(event.id);
        break;
      }
      if (verdict === "drop-unauthorized") {
        break;
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
      break;
    }
  }

  // Index into active space feeds
  indexEventIntoSpaceFeeds(event);
}

/** Validate that a string is a 64-character hex pubkey */
const HEX64_RE = /^[0-9a-f]{64}$/i;

// The decrypt queue defers gift-wrap handling with bounded concurrency; wire the
// real handler once (function declaration is hoisted, so this is safe here).
deps.decryptQueue.setHandler(handleGiftWrap);

/** Clock-skew allowance when judging a wrap's expiry (DM_WIRE_CONTRACT §5).
 *  Signal wraps live 45 s; without it a device whose clock runs ~45 s fast
 *  would reject every media key. The relay already refuses to serve an
 *  expired wrap by its own clock, so this only widens the local check. */
const WRAP_EXPIRY_SKEW_SEC = 60;

/** Handle incoming gift wrap (kind:1059) — decrypt and route to DM or friend request.
 *  `receivedAt` (unix seconds) is when the wrap reached the decrypt queue:
 *  expiry is judged against it, so a wrap that waited behind a slow signer
 *  (a NIP-46 bunker decrypts one at a time) is not rejected for the wait. */
async function handleGiftWrap(event: NostrEvent, receivedAt: number = Math.floor(Date.now() / 1000)): Promise<void> {
  const myPubkey = getState().identity.pubkey;
  if (!myPubkey) {
    // Not logged in (yet): nothing about the wrap was judged — let a later copy in.
    dedup.unmarkSeen(event.id);
    return;
  }

  // Only process wraps addressed to us. Recipient wraps from our own sends
  // bounce back from relays but can't be decrypted — some NIP-07 extensions
  // return garbage instead of throwing, creating ghost DM conversations.
  const recipientTag = event.tags.find((t) => t[0] === "p")?.[1];
  if (recipientTag && recipientTag !== myPubkey) return;

  // The wrap was marked in the dedup LRU before it reached this queue. A
  // decrypt that fails because the signer was away (NIP-46 timeout, locked
  // extension, keystore not ready) says nothing about the wrap, so unmark it:
  // the NIP-77 reconcile re-requests ids the slice never processed, and a copy
  // from another relay can arrive any time — either gets a fresh decrypt. A
  // verdict core reached itself (bad seal signature, wrong kind, expired, bad
  // ciphertext) is final for that wrap: it stays marked AND goes into the
  // slice's processed set, so the NIP-77 reconcile (which filters on that
  // set) stops re-requesting it every round.
  let dm: UnwrappedDM;
  try {
    dm = await unwrapGiftWrap(event, {
      acceptKinds: GIFT_WRAP_ACCEPT_KINDS,
      now: receivedAt - WRAP_EXPIRY_SKEW_SEC,
    });
  } catch (err) {
    if (err instanceof GiftWrapRejectedError || (err as { name?: string })?.name === "GiftWrapRejectedError") {
      dispatch(markDMWrapProcessed(event.id));
    } else {
      dedup.unmarkSeen(event.id);
    }
    return;
  }

  try {

    // Validate unwrapped data — guard against corrupted decryptions from
    // wraps not addressed to us (some NIP-07 extensions don't throw on
    // wrong-key decryption, returning garbage that may survive JSON.parse)
    if (!dm.sender || !HEX64_RE.test(dm.sender) || !Array.isArray(dm.tags)) {
      return;
    }

    // Blocked senders (kind-10000 mute list) are dropped before anything renders.
    if (dm.sender !== myPubkey) {
      const muteList = getState().identity.muteList;
      if (muteList.some((m) => m.type === "pubkey" && m.value === dm.sender)) return;
    }

    // Shared-project key DM: intercepted before parseDMWire (which would drop
    // kind 20017 as unsupported) so the nsec never reaches dmSlice or the DM store.
    if (dm.kind === KIND_DM_PROJECT_KEY) {
      handleProjectKeyWrap(dm, myPubkey);
      return;
    }

    // One parser for the spec form (kind 15 / kind 7 / `e` replies / typing /
    // receipts) and the legacy typed-rumor form (docs/DM_WIRE_CONTRACT.md §2).
    const w = parseDMWire(dm, myPubkey);
    const nowSec = Math.round(Date.now() / 1000);
    switch (w.type) {
      case "unknown":
        // Unknown kind / type from a newer client — drop rather than render
        // it as a chat bubble.
        return;
      case "friend_request":
        handleFriendRequestWrap(dm, myPubkey);
        return;
      case "friend_request_accept":
        handleFriendAcceptWrap(dm, myPubkey);
        return;
      case "friend_request_remove":
        handleFriendRemoveWrap(dm, myPubkey);
        return;
      case "call_invite":
        handleCallInviteWrap(dm, myPubkey);
        return;
      case "call_decline":
        handleCallDeclineWrap(dm, myPubkey);
        return;
      case "call_missed":
        handleCallMissedWrap(dm, myPubkey);
        return;
      case "media_key":
        // Frame-E2EE sender key for a LiveKit room we are in (docs/E2EE_CALLS.md).
        // Never rendered; the active E2EE session picks it up (or nobody does).
        if (dm.sender !== myPubkey) deliverMediaKey(dm.sender, w.envelope, dm.wrapId);
        return;
      case "edit":
        dispatch(
          editDMMessage({
            partnerPubkey: w.conversationId,
            rumorId: w.targetRumorId,
            newContent: w.content,
            editedAt: nowSec,
            senderPubkey: dm.sender,
            wrapId: dm.wrapId,
          }),
        );
        return;
      case "delete":
        dispatch(
          remoteDeleteDMMessage({
            partnerPubkey: w.conversationId,
            rumorId: w.targetRumorId,
            senderPubkey: dm.sender,
            wrapId: dm.wrapId,
          }),
        );
        return;
      case "reaction":
        dispatch(
          reactDMMessage({
            partnerPubkey: w.conversationId,
            rumorId: w.targetRumorId,
            emoji: w.emoji,
            reactorPubkey: dm.sender,
            wrapId: dm.wrapId,
          }),
        );
        return;
      case "reaction_remove":
        dispatch(
          removeDMReaction({
            partnerPubkey: w.conversationId,
            rumorId: w.targetRumorId,
            emoji: w.emoji,
            reactorPubkey: dm.sender,
            wrapId: dm.wrapId,
          }),
        );
        return;
      case "typing":
        // Judged by the rumor's own age, not the wrap's expiration: expiry
        // carries a 60 s skew allowance (WRAP_EXPIRY_SKEW_SEC), which must
        // not turn a stale typing wrap into a phantom "typing…".
        if (nowSec - dm.createdAt > DM_EXPIRATION_SECONDS.typing) return;
        if (dm.sender !== myPubkey) {
          dispatch(setTyping({ conversationId: w.conversationId, pubkey: dm.sender, until: nowSec + 6 }));
        }
        return;
      case "receipt":
        if (dm.sender !== myPubkey) {
          dispatch(
            applyReceipt({
              conversationId: w.conversationId,
              rumorIds: w.rumorIds,
              status: w.status,
              from: dm.sender,
              wrapId: dm.wrapId,
            }),
          );
        }
        return;
      case "text":
      case "file":
        break;
    }

    const isOwnMessage = dm.sender === myPubkey;
    const partnerPubkey = w.conversationId;

    // Reject if the 1:1 partner pubkey is invalid (corrupted decryption
    // artifact). Room ids are a `g` value or a sorted-participant key.
    if (!w.isRoom && (!HEX64_RE.test(partnerPubkey) || (partnerPubkey === myPubkey && !isOwnMessage))) {
      return;
    }

    // Snapshot DM state BEFORE dispatch so we can gate the notification on
    // whether this wrap was already processed (e.g. restored from IndexedDB).
    const dmState = getState().dm;
    const alreadyProcessed = !!dmState.processedWrapIdSet[dm.wrapId];

    // NIP-17: the rumor's created_at IS the real send time.
    // Only the seal and gift wrap timestamps are randomized for privacy.
    const displayTimestamp = dm.createdAt;

    dispatch(
      addDMMessage({
        partnerPubkey,
        myPubkey,
        message: {
          id: dm.wrapId,
          senderPubkey: dm.sender,
          content: w.type === "text" ? w.content : "",
          createdAt: displayTimestamp,
          wrapId: dm.wrapId,
          rumorId: dm.rumorId,
          replyToWrapId: w.replyTo,
          emojiTags: w.type === "text" && w.emojiTags.length > 0 ? w.emojiTags : undefined,
          kind: w.type === "file" ? 15 : 14,
          attachment: w.type === "file" ? w.file : undefined,
          wrapCreatedAt: event.created_at,
          expiresAt: w.expiration,
        },
        room: w.isRoom ? { participants: w.participants, subject: w.subject } : undefined,
      }),
    );

    if (!isOwnMessage && !alreadyProcessed) {
      // Delivered receipt (friends only, batched; docs/DM_WIRE_CONTRACT.md §2).
      queueDeliveredReceipt(partnerPubkey, dm.rumorId);
      // Only fire notification for genuinely new incoming messages that we're
      // not currently viewing. Prevents spurious notifications on app reload
      // when old wraps are re-fetched from relays.
      if (dmState.activeConversation !== partnerPubkey) {
        evaluateDMNotification(dm.sender, w.type === "text" ? w.content : "Sent an attachment");
      }
    }
  } catch {
    // Routing failed on a decrypted wrap — a malformed rumor, not a transient.
  }
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

/** Handle a shared-project key DM (kind 20017): validate, then keychain only.
 *  Every delivery is checked again (the store answers "known" / "forgotten"
 *  cheaply). The wrap is marked processed, which stops the NIP-77 reconcile
 *  re-requesting it, only where the key outlives a restart (OS keychain, or the
 *  web persistence opt-in): web session memory loses keys on reload, and the
 *  replayed wrap is how they come back. A failed keychain write stays unmarked. */
function handleProjectKeyWrap(dm: UnwrappedDM, myPubkey: string): void {
  const markProcessed = () => {
    if (isSecretPersistEnabled() && getState().identity.pubkey === myPubkey) {
      dispatch(markDMWrapProcessed(dm.wrapId));
    }
  };
  const grant = parseProjectKeyDM(dm, myPubkey);
  if (!grant) {
    markProcessed();
    return;
  }
  receiveProjectKey(grant, myPubkey).then(markProcessed).catch(() => {});
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
