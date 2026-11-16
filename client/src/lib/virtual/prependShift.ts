/**
 * Position math for lists that grow at the top (chat history, DMs arriving out
 * of order).
 *
 * A virtualized list addresses rows by index, so rows inserted above the
 * viewport would slide everything the reader is looking at. The virtualizer
 * avoids that when it is told how many rows were added at the head: its
 * `firstItemIndex` goes down by that count and it keeps the same rows on
 * screen. This module works that count out from the row keys alone.
 */

/** Starting index. High, so it can keep going down for a very long history. */
export const FIRST_ITEM_BASE = 1_000_000;

export interface PrependState {
  keys: readonly string[];
  firstItemIndex: number;
}

/**
 * The `firstItemIndex` for `nextKeys`, given the previous render's keys and
 * index.
 *
 * It finds the earliest previous row that is still present and compares where
 * it sat with where it sits now: further down means rows were added above it
 * (index goes down), further up means rows above it were removed (index goes
 * up). Rows added or removed after that row do not move the index. A list that
 * shares no row with the previous one is a new list and starts over.
 */
export function nextFirstItemIndex(prev: PrependState | null, nextKeys: readonly string[]): number {
  if (!prev || prev.keys.length === 0 || nextKeys.length === 0) return FIRST_ITEM_BASE;
  // Common case: nothing happened at the head.
  if (prev.keys[0] === nextKeys[0]) return prev.firstItemIndex;

  const position = new Map<string, number>();
  for (let i = 0; i < nextKeys.length; i++) position.set(nextKeys[i], i);

  for (let p = 0; p < prev.keys.length; p++) {
    const n = position.get(prev.keys[p]);
    if (n === undefined) continue;
    const next = prev.firstItemIndex - (n - p);
    // Never hand the virtualizer a negative index; restart instead.
    return next >= 0 ? next : FIRST_ITEM_BASE;
  }
  return FIRST_ITEM_BASE;
}

/**
 * True when a row was added at the tail: the last row is one the previous
 * render did not have. History arriving at the head, edits and deletions are
 * not "new at the bottom" and must not move a reader or raise a "new messages"
 * hint.
 */
export function tailAppended(prevKeys: readonly string[], nextKeys: readonly string[]): boolean {
  if (nextKeys.length === 0) return false;
  const last = nextKeys[nextKeys.length - 1];
  if (prevKeys.length === 0) return true;
  if (prevKeys[prevKeys.length - 1] === last) return false;
  // The old tail may have been removed, exposing an older row as the new tail.
  return !prevKeys.includes(last);
}
