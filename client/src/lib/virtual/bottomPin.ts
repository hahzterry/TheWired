/**
 * Pure decisions for a chat-style list that starts at its newest row and
 * follows new rows only while the reader is there. Kept free of the DOM so the
 * rules can be tested without layout.
 */

/** Scroll geometry of the list's scroller. */
export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Within `threshold` px of the end counts as "at the bottom". */
export function isNearBottom(g: ScrollGeometry, threshold: number): boolean {
  return g.scrollHeight - g.scrollTop - g.clientHeight < threshold;
}

/**
 * Whether the reader still counts as "at the bottom" after a scroll event.
 *
 * Being within the threshold of the end attaches. Only moving up while away
 * from the end releases. A scroll event that finds the reader away from the
 * end without having moved up is the content changing under them: rows
 * prepended above (the list scrolls them down by the added height), an image
 * loading, rows being measured. That must not count as leaving, or the list
 * would stop following in the middle of its own adjustment.
 */
export function nextPinned(prev: boolean, input: { nearBottom: boolean; movedUp: boolean }): boolean {
  if (input.nearBottom) return true;
  if (input.movedUp) return false;
  return prev;
}

export type AppendAction =
  /** Nothing new at the tail: leave the reader where they are. */
  | "stay"
  /** Go to the newest row. */
  | "follow"
  /** The reader is up in history: keep their place and raise the hint. */
  | "hint";

/**
 * What to do when the list changes.
 *
 * - An own send always goes to the newest row.
 * - A row arriving at the tail follows only while the reader is at the bottom;
 *   otherwise they keep their place and get the "new messages" hint.
 * - Anything else (history at the head, an edit, a deletion, the unread
 *   divider fading) moves nothing.
 */
export function onListChange(input: { ownSend: boolean; appended: boolean; atBottom: boolean }): AppendAction {
  if (input.ownSend) return "follow";
  if (!input.appended) return "stay";
  return input.atBottom ? "follow" : "hint";
}

/**
 * Whether a jump should animate. A smooth scroll across rows that were never
 * measured lands in the wrong place and drags through thousands of rows, so
 * only short hops animate; long ones go straight there.
 */
export function jumpBehavior(
  targetIndex: number,
  rendered: { startIndex: number; endIndex: number } | null,
  slack = 20,
): "smooth" | "auto" {
  if (!rendered) return "auto";
  return targetIndex >= rendered.startIndex - slack && targetIndex <= rendered.endIndex + slack ? "smooth" : "auto";
}
