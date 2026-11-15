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
import { addEvent, hideMessage, trackDeletedNote } from "../../store/slices/eventsSlice";
import { incrementEventCount } from "../../store/slices/relaysSlice";
import { profileCache } from "./profileCache";
import { decryptQueue } from "./decryptQueue";
import { evaluateNotification } from "./notificationEvaluator";
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
import { createEventIndexer } from "./pipeline/indexEvent";

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
const { indexEvent } = createEventIndexer(ctx, batching, { indexEventIntoSpaceFeeds, indexDeletion, indexModDelete });
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

// The decrypt queue defers gift-wrap handling with bounded concurrency; wire the
// real handler once (function declaration is hoisted, so this is safe here).
deps.decryptQueue.setHandler(handleGiftWrap);


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
