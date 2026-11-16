/**
 * Event pipeline: entry point and default instance.
 *
 * The pipeline itself lives in `./pipeline/`:
 *   createEventPipeline.ts  builds one pipeline from its stages (the factory)
 *   types.ts                EventPipelineDeps (injected platform couplings), PipelineContext
 *   ingest.ts               processIncomingEvent: validate → dedup → verify → dispatch → index → notify → flush
 *                           (also where a sealed space event is opened; the feature registers through ../spaceE2eeHooks)
 *   batching.ts             burst buffer, flush timer, entity sweep, cache reset
 *   sweep.ts                computeSweep (pure eviction choice)
 *   indexEvent.ts           indexEvent: THE kind switch — a new kind gets its `case` there
 *   deletionIndex.ts        kind:5 case      modDeleteIndex.ts  kind:9005 case
 *   spaceFeeds.ts           author-scoped space / friends feed indexing
 *   giftWrapHandler.ts      kind:1059: decrypt, validate, route the rumor
 *   friendWraps.ts          friend-request rumors   callWraps.ts  call-signalling rumors
 *
 * Import the pipeline from this file, not from `./pipeline/*`: this module
 * creates the one instance the app shares.
 */
import "./pipeline/evaluationOrder";
import { registerForgetSeen } from "./forgetSeen";
import { verifyBridge } from "./verifyWorkerBridge";
import { store } from "../../store";
import type { AppDispatch } from "../../store";
import { putEvent, deleteEvent, deleteAddressableEvent } from "../db/eventStore";
import { profileCache } from "./profileCache";
import { decryptQueue } from "./decryptQueue";
import { createEventPipeline } from "./pipeline/createEventPipeline";

export { createEventPipeline };
export type { EventPipeline } from "./pipeline/createEventPipeline";
export type { EventPipelineDeps } from "./pipeline/types";
export { computeSweep } from "./pipeline/sweep";

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

/** Ingest an opened sealed space event that was waiting for its key. */
export const ingestOpenedSealedEvent = defaultPipeline.ingestOpenedSealedEvent;

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
