import { LRUCache } from "lru-cache";
import type { SavedScrollPosition } from "./useAnchoredScrollRestore";

/**
 * Where the reader was in each space feed (card + offset), keyed by channel.
 * In memory only: it lets a feed reopen on the same card for the session and
 * is forgotten on reload.
 */
const positions = new LRUCache<string, SavedScrollPosition>({ max: 300 });

export function readFeedScroll(key: string | null): SavedScrollPosition | undefined {
  return key ? positions.get(key) : undefined;
}

export function writeFeedScroll(key: string | null, position: SavedScrollPosition): void {
  if (key) positions.set(key, position);
}

/** Test hook. */
export function resetFeedScrollForTests(): void {
  positions.clear();
}
