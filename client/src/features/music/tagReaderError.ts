/**
 * The audio tag reader is a large library fetched when a file is first picked
 * (see `trackFileParser.ts`). When that download fails, nothing about the file
 * is known, which is a different thing from a file with no tags: the user has
 * to be told, and to be able to try again.
 */
import { isChunkLoadError } from "@/lib/lazyWithRetry";

/**
 * Asks for a reload as well as a retry: some engines remember a failed
 * download until the page is reloaded.
 */
export const TAG_READER_LOAD_MESSAGE =
  "Couldn't read the file's tags. Check your connection and try again, or reload the app if it keeps failing.";

/** The tag reader could not be downloaded, so the file was not read at all. */
export class TagReaderLoadError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(TAG_READER_LOAD_MESSAGE);
    this.name = "TagReaderLoadError";
    this.cause = cause;
  }
}

/** True for `TagReaderLoadError`, and for a raw failed-chunk error on the way to the reader. */
export function isTagReaderLoadError(err: unknown): boolean {
  if ((err as { name?: unknown } | null)?.name === "TagReaderLoadError") return true;
  return isChunkLoadError(err);
}
