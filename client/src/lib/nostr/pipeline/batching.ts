import type { NostrEvent } from "../../../types/nostr";
import { EVENT_KINDS } from "../../../types/nostr";
import type { UnknownAction } from "@reduxjs/toolkit";
import { addEvent, addEvents, indexChatMessage, indexReel, indexLongForm, indexLiveStream, indexNote, indexSpaceFeed, indexMusicTrack, indexMusicAlbum, indexReply, indexRepost, indexRepostByAuthor, indexQuote, removeManyEvents, indexNotes, indexReplies, indexReposts, indexRepostsByAuthor, indexQuotes, indexChatMessages, indexReels, indexLongForms, indexLiveStreams, indexMusicTracks, indexMusicAlbums, indexSpaceFeeds } from "../../../store/slices/eventsSlice";
import { addReaction, addReactions, type ReactionInput } from "../../../store/slices/reactionsSlice";
import { addZap, addZaps, type ZapInput } from "../../../store/slices/zapsSlice";
import { addPollVote, addPollVotes, type PollVoteInput } from "../../../store/slices/pollsSlice";
import { incrementEventCount, incrementCounts } from "../../../store/slices/relaysSlice";
import { trackFeedTimestamp, trackFeedTimestamps } from "../../../store/slices/feedSlice";
import type { PipelineContext } from "./types";
import { computeSweep } from "./sweep";

export type Batching = ReturnType<typeof createBatching>;

/**
 * Burst-path dispatch batching, the entity-store soft cap, and the reset of
 * everything a pipeline caches. One instance per pipeline: the buffer, the
 * flush timer and the sweep counter live in this closure.
 *
 * The body is the code as it stood inside `createEventPipeline`, at its
 * original indentation.
 */
export function createBatching(ctx: PipelineContext) {
  const { deps, dispatch, getState, dedup, authorSetCache } = ctx;

  // ── Burst-path dispatch batching ──────────────────────────────────────
  // At ~600 events/sec, dispatching addEvent + index actions individually pegs
  // the main thread (every store.dispatch re-runs every mounted selector). We
  // buffer the burst path (events from real relays) and flush coalesced
  // array-dispatches on a short timer. Synthetic sources (optimistic sends,
  // resolvers) flush synchronously so callers that await still read fresh state.
  const FLUSH_MS = 50;
  const FLUSH_CHAT_MS = 16; // chat is perceptibly live — flush within ~one frame
  const MAX_BUFFER = 256; // hard cap: flush early on backfill / background-tab bursts

  interface PipelineBuffer {
    events: NostrEvent[];
    counts: Record<string, number>;
    notes: { pubkey: string; eventId: string }[];
    reactions: ReactionInput[];
    zaps: ZapInput[];
    pollVotes: PollVoteInput[];
    replies: { parentEventId: string; eventId: string }[];
    reposts: { targetEventId: string; eventId: string }[];
    repostsByAuthor: { pubkey: string; eventId: string }[];
    quotes: { targetEventId: string; eventId: string }[];
    chatMessages: { groupId: string; eventId: string }[];
    reels: { contextId: string; eventId: string }[];
    longform: { contextId: string; eventId: string }[];
    liveStreams: { contextId: string; eventId: string }[];
    musicTracks: { contextId: string; eventId: string }[];
    musicAlbums: { contextId: string; eventId: string }[];
    spaceFeeds: { contextId: string; eventId: string }[];
    feedTimestamps: { contextId: string; createdAt: number }[];
  }

  function emptyBuffer(): PipelineBuffer {
    return {
      events: [], counts: {}, notes: [], reactions: [], zaps: [], pollVotes: [], replies: [],
      reposts: [], repostsByAuthor: [], quotes: [], chatMessages: [], reels: [], longform: [],
      liveStreams: [], musicTracks: [], musicAlbums: [], spaceFeeds: [], feedTimestamps: [],
    };
  }

  let buf: PipelineBuffer = emptyBuffer();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledDelay = FLUSH_MS;

  /** True when the event arrived from a real relay (ws://) rather than a synthetic
   *  source: "local" (optimistic sends) or "resolve"/"search"/"browse"/"embedded". */
  function isBurstSource(relayUrl: string): boolean {
    return relayUrl.startsWith("ws://") || relayUrl.startsWith("wss://");
  }

  /** Route a Redux action through the burst buffer when batchable, else dispatch
   *  immediately. RTK `.match` keeps each payload strongly typed. */
  function emit(action: UnknownAction): void {
    if (addEvent.match(action)) { buf.events.push(action.payload); return; }
    if (incrementEventCount.match(action)) {
      const url = action.payload;
      buf.counts[url] = (buf.counts[url] ?? 0) + 1;
      return;
    }
    if (indexNote.match(action)) { buf.notes.push(action.payload); return; }
    if (addReaction.match(action)) { buf.reactions.push(action.payload); return; }
    if (addZap.match(action)) { buf.zaps.push(action.payload); return; }
    if (addPollVote.match(action)) { buf.pollVotes.push(action.payload); return; }
    if (indexReply.match(action)) { buf.replies.push(action.payload); return; }
    if (indexRepost.match(action)) { buf.reposts.push(action.payload); return; }
    if (indexRepostByAuthor.match(action)) { buf.repostsByAuthor.push(action.payload); return; }
    if (indexQuote.match(action)) { buf.quotes.push(action.payload); return; }
    if (indexChatMessage.match(action)) { buf.chatMessages.push(action.payload); return; }
    if (indexReel.match(action)) { buf.reels.push(action.payload); return; }
    if (indexLongForm.match(action)) { buf.longform.push(action.payload); return; }
    if (indexLiveStream.match(action)) { buf.liveStreams.push(action.payload); return; }
    if (indexMusicTrack.match(action)) { buf.musicTracks.push(action.payload); return; }
    if (indexMusicAlbum.match(action)) { buf.musicAlbums.push(action.payload); return; }
    if (indexSpaceFeed.match(action)) { buf.spaceFeeds.push(action.payload); return; }
    if (trackFeedTimestamp.match(action)) { buf.feedTimestamps.push(action.payload); return; }
    dispatch(action); // not batchable → immediate
  }

  function bufferHasData(b: PipelineBuffer): boolean {
    return (
      b.events.length > 0 || b.notes.length > 0 || b.reactions.length > 0 ||
      b.zaps.length > 0 || b.pollVotes.length > 0 ||
      b.replies.length > 0 || b.reposts.length > 0 || b.repostsByAuthor.length > 0 ||
      b.quotes.length > 0 || b.chatMessages.length > 0 || b.reels.length > 0 ||
      b.longform.length > 0 || b.liveStreams.length > 0 || b.musicTracks.length > 0 ||
      b.musicAlbums.length > 0 || b.spaceFeeds.length > 0 || b.feedTimestamps.length > 0 ||
      Object.keys(b.counts).length > 0
    );
  }

  /** Schedule a coalesced flush of the burst buffer. Chat flushes within ~a frame;
   *  everything else within FLUSH_MS. A full buffer flushes immediately. */
  function scheduleFlush(kind: number): void {
    if (buf.events.length >= MAX_BUFFER) {
      flushEventPipeline();
      return;
    }
    const delay = kind === EVENT_KINDS.CHAT_MESSAGE ? FLUSH_CHAT_MS : FLUSH_MS;
    if (flushTimer !== null) {
      if (delay >= scheduledDelay) return; // already scheduled at least this soon
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    scheduledDelay = delay;
    flushTimer = setTimeout(flushEventPipeline, delay);
  }

  // ── Entity-store soft cap (B2) ───────────────────────────────────────────────
  // The Redux event entity store is otherwise unbounded — it grows all session and
  // the adapter's sortComparer pays an insertion-sort on every upsert. sweepEvents
  // trims the OLDEST UNREFERENCED entities back under a soft cap. "Unreferenced" =
  // no secondary index points at the id, so chat (chatMessages is uncapped) and any
  // open feed are protected by construction. Evicted ids are UNMARKED from the
  // dedup LRU so a later re-delivery / re-REQ can bring them back — without that the
  // 100k dedup cache would silently swallow the re-fetch.
  const ENTITY_SOFT_CAP = 20_000;
  const ENTITY_SWEEP_TARGET = 18_000; // hysteresis: once over cap, trim down to this
  const SWEEP_CHECK_EVERY = 4; // only run the O(n) scan every Nth flush
  let flushesSinceSweepCheck = 0;

  function sweepWithCaps(softCap: number, target: number): void {
    const events = getState().events;
    const indices: Array<Record<string, string[]>> = [
      events.chatMessages, events.reels, events.longform, events.liveStreams,
      events.notesByAuthor, events.spaceFeeds, events.musicTracks, events.musicAlbums,
      events.replies, events.reposts, events.repostsByAuthor, events.quotes,
    ];
    const evict = computeSweep(events.ids, indices, events.editedMessages, softCap, target);
    if (evict.length === 0) return;
    dispatch(removeManyEvents(evict));
    // CRITICAL: unmark from the dedup LRU so a re-delivery / re-REQ can bring the
    // event back. Skipping this makes evicted events un-refetchable for the session.
    for (let i = 0; i < evict.length; i++) dedup.unmarkSeen(evict[i]);
  }

  function sweepEvents(): void {
    if (++flushesSinceSweepCheck < SWEEP_CHECK_EVERY) return;
    flushesSinceSweepCheck = 0;
    sweepWithCaps(ENTITY_SOFT_CAP, ENTITY_SWEEP_TARGET);
  }

  /** Test-only: run the sweep with explicit caps (so a test needn't seed 20k events). */
  function __sweepForTest(softCap: number, target: number): void {
    sweepWithCaps(softCap, target);
  }

  /** Apply all buffered burst-path ops in one batch — events first, then indices,
   *  so every index entry's event is already in the adapter. Exported for tests
   *  and for synchronous flushing on logout / account switch. */
  function flushEventPipeline(): void {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    scheduledDelay = FLUSH_MS;
    if (!bufferHasData(buf)) return;
    const b = buf;
    buf = emptyBuffer();
    // Entities first — indices reference them.
    if (b.events.length) dispatch(addEvents(b.events));
    if (Object.keys(b.counts).length) dispatch(incrementCounts(b.counts));
    if (b.notes.length) dispatch(indexNotes(b.notes));
    if (b.reactions.length) dispatch(addReactions(b.reactions));
    if (b.zaps.length) dispatch(addZaps(b.zaps));
    if (b.pollVotes.length) dispatch(addPollVotes(b.pollVotes));
    if (b.replies.length) dispatch(indexReplies(b.replies));
    if (b.reposts.length) dispatch(indexReposts(b.reposts));
    if (b.repostsByAuthor.length) dispatch(indexRepostsByAuthor(b.repostsByAuthor));
    if (b.quotes.length) dispatch(indexQuotes(b.quotes));
    if (b.chatMessages.length) dispatch(indexChatMessages(b.chatMessages));
    if (b.reels.length) dispatch(indexReels(b.reels));
    if (b.longform.length) dispatch(indexLongForms(b.longform));
    if (b.liveStreams.length) dispatch(indexLiveStreams(b.liveStreams));
    if (b.musicTracks.length) dispatch(indexMusicTracks(b.musicTracks));
    if (b.musicAlbums.length) dispatch(indexMusicAlbums(b.musicAlbums));
    if (b.spaceFeeds.length) dispatch(indexSpaceFeeds(b.spaceFeeds));
    if (b.feedTimestamps.length) dispatch(trackFeedTimestamps(b.feedTimestamps));

    // Bound the entity store after the batch lands (indices are populated, so
    // freshly-added events are already referenced and won't be swept).
    sweepEvents();
  }

  /** Let events that were deliberately dropped from the store be delivered
   *  again. Without this the dedup LRU swallows the re-fetch for the rest of the
   *  session (e.g. a space's music after the viewer leaves and rejoins). */
  function forgetSeenEvents(ids: readonly string[]): void {
    for (const id of ids) dedup.unmarkSeen(id);
  }

  /** Clear all module-level caches (used during account switch) */
  function resetEventPipelineCaches(): void {
    // Drop any pending burst buffer so a stray timer can't repopulate the store
    // after RESET_ALL wipes it on account switch.
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    buf = emptyBuffer();
    scheduledDelay = FLUSH_MS;
    flushesSinceSweepCheck = 0;
    dedup.clear();
    deps.decryptQueue.clear(); // drop queued wraps for the previous account
    authorSetCache.clear();
  }

  return {
    emit,
    isBurstSource,
    scheduleFlush,
    flushEventPipeline,
    forgetSeenEvents,
    resetEventPipelineCaches,
    __sweepForTest,
  };
}
