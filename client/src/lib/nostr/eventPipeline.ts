import { EventDeduplicator } from "./dedup";
import { registerForgetSeen } from "./forgetSeen";
import { verifyBridge } from "./verifyWorkerBridge";
import { store } from "../../store";
import type { AppDispatch } from "../../store";
import { putEvent, deleteEvent, deleteAddressableEvent } from "../db/eventStore";
import { profileCache } from "./profileCache";
import { decryptQueue } from "./decryptQueue";
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
import { createIngest } from "./pipeline/ingest";

export type { EventPipelineDeps };
export { computeSweep };



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
const { flushEventPipeline, resetEventPipelineCaches, forgetSeenEvents, __sweepForTest } = batching;
const { indexEventIntoSpaceFeeds } = createSpaceFeedIndexer(ctx, batching);
const { handleCallInviteWrap, handleCallDeclineWrap, handleCallMissedWrap } = createCallWrapHandlers(ctx);
const { handleFriendRequestWrap, handleFriendAcceptWrap, handleFriendRemoveWrap } = createFriendWrapHandlers(ctx);
const { indexDeletion } = createDeletionIndexer(ctx, batching);
const { indexModDelete } = createModDeleteIndexer(ctx, batching);
const { indexEvent } = createEventIndexer(ctx, batching, { indexEventIntoSpaceFeeds, indexDeletion, indexModDelete });
const { processIncomingEvent } = createIngest(ctx, batching, { indexEvent });
const { handleGiftWrap } = createGiftWrapHandler(ctx, {
  handleFriendRequestWrap,
  handleFriendAcceptWrap,
  handleFriendRemoveWrap,
  handleCallInviteWrap,
  handleCallDeclineWrap,
  handleCallMissedWrap,
});


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
