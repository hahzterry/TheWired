/**
 * Keeps a reader's place in a virtualized list while nothing is scrolling.
 *
 * A plain scrolling element gets this from the browser (CSS scroll anchoring):
 * when something above the viewport changes height, the browser moves the
 * scroll offset by the same amount and nothing on screen shifts. The
 * virtualizer switches that off, because it does its own bookkeeping, and its
 * bookkeeping only covers rows it measures while the list is being scrolled
 * up (it stops compensating a moment after scrolling stops). What is left
 * over is the list at rest: a rendered row above the viewport changes height
 * (media arriving late, a card collapsing), nothing compensates, and the page
 * shifts.
 *
 * This keeper covers that. Once scrolling has been quiet for a moment it
 * remembers the row at the top of the viewport and where it sits; when the
 * content then changes size, it puts that row back.
 *
 * It never undoes a scroll. Every scroll, whoever made it (the reader, a
 * jump, a script), is taken as the new place. The one exception is announced
 * by the list itself: when rows are added above the viewport the virtualizer
 * scrolls by their estimated height to make room, and the remembered row is
 * kept through that and put back exactly once the new rows are measured.
 *
 * It also stands down at the very top of a list, where new rows are meant to
 * push in, and while the list is pinned to its end.
 *
 * One more thing it has to handle is the virtualizer answering the keeper.
 * A correction that scrolls the list up (a row above shrank) looks to the
 * virtualizer like the reader scrolling up, and for a moment after that it
 * compensates for size changes above the viewport itself, by scrolling the
 * list through the element's `scrollBy`: sometimes for the very change the
 * keeper has just handled, sometimes by an amount worked out from stale
 * state. Either way the reader ends up somewhere else. So the keeper is told
 * of every such scroll as it happens (`onVirtualizerScroll`) and puts its row
 * back there and then, before anything is painted. If the virtualizer's
 * scroll was the right one, the row is already in place and nothing happens.
 */

/** How long after the last input the reader still counts as scrolling. */
export const USER_SCROLL_IDLE_MS = 600;

/** How long scrolling must be quiet before the place is remembered. */
export const SCROLL_SETTLE_MS = 150;

/** How long the virtualizer may take to make room for rows added above. */
export const SHIFT_HOLD_MS = 500;

/** How long a shift must be quiet before the remembered row is put back. */
const SHIFT_SETTLE_MS = 50;

const programmaticUntil = new WeakMap<Element, number>();

/**
 * Tell the keeper that the app is scrolling this element on purpose (a jump
 * to a message, a scroll restore that re-pins for a while), for the next
 * `ms`. Rows may be measured and re-laid-out during that time; the keeper
 * makes no corrections until it is over, then takes the place it landed on.
 */
export function markProgrammaticScroll(scroller: Element | null | undefined, ms: number): void {
  if (!scroller) return;
  const until = Date.now() + ms;
  if ((programmaticUntil.get(scroller) ?? 0) < until) programmaticUntil.set(scroller, until);
}

function programmaticRemaining(scroller: Element): number {
  return Math.max(0, (programmaticUntil.get(scroller) ?? 0) - Date.now());
}

export interface ViewportAnchorOptions {
  scroller: HTMLElement;
  /** The element whose children are the rendered rows. */
  list: HTMLElement;
  /** True while the list is pinned to its end (the pin owns the position). */
  isPinned?: () => boolean;
}

interface Anchor {
  row: Element;
  /** The row's top edge relative to the scroller's top edge, in px. */
  top: number;
}

export class ViewportAnchor {
  private readonly scroller: HTMLElement;
  private readonly list: HTMLElement;
  private readonly isPinned: () => boolean;
  private anchor: Anchor | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Where the keeper last put the list. A scroll event that finds the list
   * there is the keeper's own (or a virtualizer scroll it undid), not a new
   * place, however many moves were folded into that one event.
   */
  private heldTop: number | null = null;
  /** True while the keeper itself is scrolling the list. */
  private restoring = false;
  /** Rows are being added above the viewport until this time. */
  private shiftUntil = 0;
  private shiftTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor({ scroller, list, isPinned }: ViewportAnchorOptions) {
    this.scroller = scroller;
    this.list = list;
    this.isPinned = isPinned ?? (() => false);
    this.settleAfter(SCROLL_SETTLE_MS);
  }

  onScroll(): void {
    if (this.disposed) return;
    if (this.heldTop !== null) {
      if (Math.abs(this.scroller.scrollTop - this.heldTop) < 1) return;
      this.heldTop = null;
    }
    if (this.anchor && Date.now() < this.shiftUntil) {
      // The virtualizer making room for rows added above: the reader's row is
      // still the reader's row. Put it back once the shift has settled.
      this.holdAfterShift();
      return;
    }
    // The list is moving: forget the place and take the new one once it rests.
    this.anchor = null;
    this.settleAfter(Math.max(SCROLL_SETTLE_MS, programmaticRemaining(this.scroller) + 50));
  }

  /** The content or the scroller changed size. */
  onResize(): void {
    if (this.disposed) return;
    const programmatic = programmaticRemaining(this.scroller);
    if (programmatic > 0) {
      this.anchor = null;
      this.settleAfter(programmatic + 50);
      return;
    }
    // Still scrolling (no place remembered yet): not ours to correct.
    if (!this.anchor) return;
    if (Date.now() < this.shiftUntil) {
      // Mid-shift the virtualizer offsets the rows for a frame or two; wait.
      this.holdAfterShift();
      return;
    }
    this.restore();
  }

  /**
   * Rows are about to be added above the viewport (the list calls this when
   * it tells the virtualizer). The remembered row is kept through the scroll
   * that makes room for them, instead of that scroll being taken as a new
   * place.
   */
  expectShift(): void {
    if (this.disposed || !this.anchor) return;
    this.shiftUntil = Date.now() + SHIFT_HOLD_MS;
    this.holdAfterShift();
  }

  /**
   * The virtualizer has just scrolled the list itself, through the element's
   * `scrollBy` (we are still inside its call). While a place is remembered
   * and nothing else owns the position, put the remembered row back at once.
   */
  onVirtualizerScroll(): void {
    if (this.disposed || this.restoring || !this.anchor) return;
    // A jump made by the app: the scroll event drops the place, as always.
    if (programmaticRemaining(this.scroller) > 0) return;
    // Making room for rows added above: put back once the shift has settled.
    if (Date.now() < this.shiftUntil) return;
    this.restore();
  }

  private holdAfterShift(): void {
    if (this.shiftTimer !== null) clearTimeout(this.shiftTimer);
    this.shiftTimer = setTimeout(() => {
      this.shiftTimer = null;
      if (this.disposed) return;
      this.restore();
    }, SHIFT_SETTLE_MS);
  }

  /** Put the remembered row back where it was. */
  private restore(): void {
    if (!this.anchor) return;
    if (this.standsDown() || !this.anchor.row.isConnected) {
      this.anchor = null;
      this.settleAfter(SCROLL_SETTLE_MS);
      return;
    }
    const top = this.anchor.row.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top;
    const delta = top - this.anchor.top;
    if (Math.abs(delta) >= 1) this.scrollBy(delta);
  }

  dispose(): void {
    this.disposed = true;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    if (this.shiftTimer !== null) clearTimeout(this.shiftTimer);
    this.settleTimer = null;
    this.shiftTimer = null;
    this.anchor = null;
    this.heldTop = null;
  }

  private settleAfter(ms: number): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.settle();
    }, ms);
  }

  /** Scrolling has stopped: remember the reader's place. */
  private settle(): void {
    if (this.disposed) return;
    const wait = programmaticRemaining(this.scroller);
    if (wait > 0) {
      this.settleAfter(wait + 20);
      return;
    }
    this.capture();
  }

  /** True when there is nothing above the viewport to protect, or no say here. */
  private standsDown(): boolean {
    if (this.isPinned()) return true;
    if (this.scroller.scrollTop <= 0) return true;
    // The start of the list is in view: rows added there are meant to push in.
    return this.list.getBoundingClientRect().top >= this.scroller.getBoundingClientRect().top - 1;
  }

  private capture(): void {
    this.anchor = null;
    this.heldTop = null;
    if (this.standsDown()) return;
    const edge = this.scroller.getBoundingClientRect().top;
    for (const row of this.list.children) {
      const rect = row.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > edge + 1) {
        this.anchor = { row, top: rect.top - edge };
        return;
      }
    }
  }

  /**
   * Scroll by `delta` and remember where that left the list. It goes through
   * the element's `scrollBy`, like the virtualizer's own corrections, so that
   * a list which tells its own scrolling from the reader's (the chat lists)
   * does not take the keeper's correction for the reader moving.
   */
  private scrollBy(delta: number): void {
    const before = this.scroller.scrollTop;
    this.restoring = true;
    try {
      this.scroller.scrollBy({ top: delta, behavior: "instant" });
    } finally {
      this.restoring = false;
    }
    if (this.scroller.scrollTop !== before) this.heldTop = this.scroller.scrollTop;
  }
}
