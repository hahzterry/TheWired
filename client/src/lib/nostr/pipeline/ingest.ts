import type { NostrEvent } from "../../../types/nostr";
import { EVENT_KINDS } from "../../../types/nostr";
import { clearPendingDeletion } from "../../../store/slices/eventsSlice";
import { isValidEventStructure } from "../validation";
import { addEvent, hideMessage, trackDeletedNote } from "../../../store/slices/eventsSlice";
import { incrementEventCount } from "../../../store/slices/relaysSlice";
import { evaluateNotification } from "../notificationEvaluator";
import { createLogger, shortKey, shortRelay } from "../../debug/logger";
import type { PipelineContext } from "./types";
import type { Batching } from "./batching";

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

/**
 * `processIncomingEvent`: the stages every incoming event passes, in order:
 * validate, dedup, verify, the gift-wrap exit, the deleted-content guards,
 * dispatch, index, notify, flush.
 *
 * The body is the code as it stood inside `createEventPipeline`, at its
 * original indentation.
 */
export function createIngest(
  ctx: PipelineContext,
  batching: Batching,
  stages: { indexEvent(event: NostrEvent, relayUrl: string): Promise<void> },
) {
  const { deps, dispatch, getState, dedup } = ctx;
  const { emit, isBurstSource, scheduleFlush, flushEventPipeline } = batching;
  const { indexEvent } = stages;

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

  return { processIncomingEvent };
}
