import { EventDeduplicator } from "../dedup";
import type { EventPipelineDeps, PipelineContext } from "./types";
import { createBatching } from "./batching";
import { createSpaceFeedIndexer } from "./spaceFeeds";
import { createCallWrapHandlers } from "./callWraps";
import { createFriendWrapHandlers } from "./friendWraps";
import { createGiftWrapHandler } from "./giftWrapHandler";
import { createDeletionIndexer } from "./deletionIndex";
import { createModDeleteIndexer } from "./modDeleteIndex";
import { createEventIndexer } from "./indexEvent";
import { createIngest } from "./ingest";

// ── Dependency inversion (Phase 0, guide 01 §4) ──────────────────────────────
// The pipeline's logic is pure and portable; its platform couplings (Redux
// store, Web Worker verifier, IndexedDB persistence, profile cache, decrypt
// queue) are injected here. The desktop wires its existing singletons into a
// default instance in `../eventPipeline.ts` — behavior-identical to the old
// module-level form.

export type EventPipeline = ReturnType<typeof createEventPipeline>;

export function createEventPipeline(deps: EventPipelineDeps) {
  const { dispatch, getState } = deps;

  const dedup = new EventDeduplicator();

  // Cached Set for space author lookups (O(1) instead of O(n) per check)
  const authorSetCache = new Map<string, { set: Set<string>; fingerprint: string }>();

  const ctx: PipelineContext = { deps, dispatch, getState, dedup, authorSetCache };

  // Stages, each closing over the same context. Order matters only in that a
  // stage is built before the stages that call it.
  const batching = createBatching(ctx);
  const { flushEventPipeline, resetEventPipelineCaches, forgetSeenEvents, __sweepForTest } = batching;
  const { indexEventIntoSpaceFeeds } = createSpaceFeedIndexer(ctx, batching);
  const { indexDeletion } = createDeletionIndexer(ctx, batching);
  const { indexModDelete } = createModDeleteIndexer(ctx, batching);
  const { indexEvent } = createEventIndexer(ctx, batching, { indexEventIntoSpaceFeeds, indexDeletion, indexModDelete });
  const { processIncomingEvent } = createIngest(ctx, batching, { indexEvent });
  const { handleGiftWrap } = createGiftWrapHandler(ctx, {
    ...createFriendWrapHandlers(ctx),
    ...createCallWrapHandlers(ctx),
  });

  // The decrypt queue defers gift-wrap handling with bounded concurrency; wire the
  // real handler once.
  deps.decryptQueue.setHandler(handleGiftWrap);

  return {
    processIncomingEvent,
    flushEventPipeline,
    resetEventPipelineCaches,
    forgetSeenEvents,
    __sweepForTest,
  };
}
