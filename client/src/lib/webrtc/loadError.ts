// The voice and video code is fetched on the first join (see `livekit.ts`).
// When that download fails, the join fails for a reason that has nothing to
// do with the call: the connection dropped, or the app was updated and the
// file is gone. This is the error for that case and the sentence the user
// reads, shared by voice channels and direct calls.
import { isChunkLoadError } from "@/lib/lazyWithRetry";

/**
 * Asks for a reload as well as a retry: after an update the old file is gone
 * for good, and some engines remember a failed download until the page is
 * reloaded, so trying again is not always enough.
 */
export const MEDIA_ENGINE_LOAD_MESSAGE =
  "Couldn't load voice and video. Check your connection and try again. If it keeps failing, reload the app.";

/** The voice and video code could not be downloaded. */
export class MediaEngineLoadError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(MEDIA_ENGINE_LOAD_MESSAGE);
    this.name = "MediaEngineLoadError";
    this.cause = cause;
  }
}

/** True for `MediaEngineLoadError` and for a raw failed-chunk error from any lazy import on the way to a join. */
export function isMediaEngineLoadError(err: unknown): boolean {
  if ((err as { name?: unknown } | null)?.name === "MediaEngineLoadError") return true;
  return isChunkLoadError(err);
}
