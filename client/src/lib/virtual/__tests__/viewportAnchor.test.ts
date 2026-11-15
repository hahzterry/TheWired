import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SCROLL_SETTLE_MS, SHIFT_HOLD_MS, ViewportAnchor, markProgrammaticScroll } from "../viewportAnchor";

/**
 * jsdom has no layout, so geometry is modelled: the list's rows sit at content
 * offsets that follow from their heights, and every rect is derived from the
 * scroller's scrollTop, like a real scrolling element.
 */
interface Model {
  scroller: HTMLDivElement;
  list: HTMLDivElement;
  heights: number[];
  rows: HTMLDivElement[];
  /** Blank space before the first row (the virtualizer's offset for unrendered rows). */
  padTop: number;
}

function model(heights: number[], padTop = 0): Model {
  const scroller = document.createElement("div");
  const list = document.createElement("div");
  scroller.appendChild(list);
  document.body.appendChild(scroller);
  const m: Model = { scroller, list, heights: [...heights], rows: [], padTop };
  scroller.getBoundingClientRect = () => rect(100, 600);
  list.getBoundingClientRect = () => rect(100 - scroller.scrollTop, m.padTop + m.heights.reduce((a, b) => a + b, 0));
  heights.forEach((_, i) => {
    const row = document.createElement("div");
    row.getBoundingClientRect = () => {
      const before = m.heights.slice(0, i).reduce((a, b) => a + b, 0);
      return rect(100 - scroller.scrollTop + m.padTop + before, m.heights[i]);
    };
    list.appendChild(row);
    m.rows.push(row);
  });
  return m;
}

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

/** Where a row's top edge is, relative to the scroller's top edge. */
const topOf = (m: Model, i: number) => m.rows[i].getBoundingClientRect().top - 100;

describe("ViewportAnchor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Scroll the model somewhere and tell the keeper, as a scroll event would. */
  function scrollTo(m: Model, keeper: ViewportAnchor, scrollTop: number) {
    m.scroller.scrollTop = scrollTop;
    keeper.onScroll();
  }

  /** A keeper whose list was scrolled to `scrollTop` and has come to rest. */
  function settled(m: Model, scrollTop: number, opts: { up?: boolean; isPinned?: () => boolean } = {}) {
    const keeper = new ViewportAnchor({ scroller: m.scroller, list: m.list, isPinned: opts.isPinned });
    scrollTo(m, keeper, opts.up ? scrollTop + 300 : Math.max(0, scrollTop - 300));
    scrollTo(m, keeper, scrollTop);
    vi.advanceTimersByTime(SCROLL_SETTLE_MS + 20);
    return keeper;
  }

  it("holds the reader's row when a row above the viewport grows", () => {
    const m = model([200, 200, 200, 200, 200, 200]);
    const keeper = settled(m, 500); // row 2 is at the top edge, 100px scrolled into
    expect(topOf(m, 2)).toBe(-100);

    m.heights[0] = 320; // an image in the first row arrives
    expect(topOf(m, 2)).toBe(20); // everything below it moved down
    keeper.onResize();
    expect(m.scroller.scrollTop).toBe(620);
    expect(topOf(m, 2)).toBe(-100);
  });

  it("holds the reader's row when a row above the viewport shrinks", () => {
    const m = model([200, 200, 200, 200, 200, 200]);
    const keeper = settled(m, 500);
    m.heights[1] = 140;
    keeper.onResize();
    expect(m.scroller.scrollTop).toBe(440);
    expect(topOf(m, 2)).toBe(-100);
  });

  it("does not move for a change below the reader's row", () => {
    const m = model([200, 200, 200, 200, 200, 200]);
    const keeper = settled(m, 500);
    m.heights[4] = 900; // a streamed reply growing further down
    keeper.onResize();
    expect(m.scroller.scrollTop).toBe(500);
  });

  it("never undoes a scroll, whoever made it", () => {
    const m = model([200, 200, 200, 200, 200, 200]);
    const keeper = settled(m, 500);
    // No input events are involved: a script, a jump, keys with the focus
    // elsewhere, the virtualizer making room for prepended rows.
    scrollTo(m, keeper, 800);
    expect(m.scroller.scrollTop).toBe(800);
    keeper.onResize();
    expect(m.scroller.scrollTop).toBe(800);
    scrollTo(m, keeper, 300);
    expect(m.scroller.scrollTop).toBe(300);
  });

  it("makes no corrections while the list is scrolling, then holds the place it came to rest on", () => {
    const m = model([200, 200, 200, 200, 200, 200]);
    const keeper = settled(m, 500);
    scrollTo(m, keeper, 700);
    m.heights[0] = 320;
    keeper.onResize(); // mid-scroll: not ours to fix
    expect(m.scroller.scrollTop).toBe(700);

    vi.advanceTimersByTime(SCROLL_SETTLE_MS + 20);
    const row = m.rows.findIndex((_, i) => topOf(m, i) + m.heights[i] > 1);
    const held = topOf(m, row);
    m.heights[0] = 400;
    keeper.onResize();
    expect(topOf(m, row)).toBe(held);
    expect(m.scroller.scrollTop).toBe(780);
  });

  it("each scroll restarts the wait, so a continuous scroll is never interrupted", () => {
    const m = model([200, 200, 200, 200, 200, 200]);
    const keeper = settled(m, 500);
    for (let top = 520; top <= 700; top += 20) {
      scrollTo(m, keeper, top);
      vi.advanceTimersByTime(SCROLL_SETTLE_MS - 30); // quiet, but not for long enough
      m.heights[0] += 10;
      keeper.onResize();
      expect(m.scroller.scrollTop).toBe(top);
    }
  });

  it("takes the place as it is after an upward scroll too, without moving the list", () => {
    const m = model([200, 200, 200, 200, 200, 200]);
    const keeper = settled(m, 500, { up: true });
    expect(m.scroller.scrollTop).toBe(500);
    m.heights[0] = 260;
    keeper.onResize();
    expect(m.scroller.scrollTop).toBe(560);
  });

  it("stands down at the very top, where new rows are meant to push in", () => {
    const m = model([200, 200, 200]);
    const keeper = new ViewportAnchor({ scroller: m.scroller, list: m.list });
    vi.advanceTimersByTime(SCROLL_SETTLE_MS + 20);
    m.heights[0] = 350;
    keeper.onResize();
    expect(m.scroller.scrollTop).toBe(0);
  });

  it("stands down while the start of the list is in view below other content", () => {
    // A feed under a header: scrolled 50px, the list starts 80px further down.
    const m = model([200, 200, 200, 200], 0);
    m.list.getBoundingClientRect = () => rect(180 - m.scroller.scrollTop, 800);
    const keeper = settled(m, 50);
    m.heights[0] = 400;
    keeper.onResize();
    expect(m.scroller.scrollTop).toBe(50);
  });

  it("stands down while the list is pinned to its end", () => {
    const m = model([200, 200, 200, 200, 200, 200]);
    let pinned = false;
    const keeper = settled(m, 500, { isPinned: () => pinned });
    pinned = true;
    m.heights[0] = 320;
    keeper.onResize();
    expect(m.scroller.scrollTop).toBe(500);
  });

  it("makes no corrections while the app scrolls the list on purpose, then holds where it landed", () => {
    const m = model([200, 200, 200, 200, 200, 200]);
    const keeper = settled(m, 500);
    markProgrammaticScroll(m.scroller, 1000); // a scroll restore re-pinning for a while
    m.heights[0] = 320; // rows being measured meanwhile
    keeper.onResize();
    expect(m.scroller.scrollTop).toBe(500); // left alone
    scrollTo(m, keeper, 900);
    vi.advanceTimersByTime(1100);

    m.heights[0] = 400;
    keeper.onResize();
    expect(m.scroller.scrollTop).toBe(980);
  });

  it("keeps the reader's row through the scroll that makes room for rows added above", () => {
    const m = model([200, 200, 200, 200, 200, 200]);
    const keeper = settled(m, 500); // row 2, 100px scrolled into
    keeper.expectShift();
    // The virtualizer scrolls by the estimated height of the new rows (two
    // rows guessed at 60px each)...
    m.padTop = 120;
    scrollTo(m, keeper, 620);
    expect(topOf(m, 2)).toBe(-100);
    // ...and they then measure 100px each, 80px more than guessed.
    m.padTop = 200;
    keeper.onResize();
    expect(topOf(m, 2)).toBe(-20); // not corrected in the middle of the shift
    vi.advanceTimersByTime(60);
    expect(topOf(m, 2)).toBe(-100);
    expect(m.scroller.scrollTop).toBe(700);
  });

  it("goes back to taking scrolls as the new place once the shift is over", () => {
    const m = model([200, 200, 200, 200, 200, 200]);
    const keeper = settled(m, 500);
    keeper.expectShift();
    m.padTop = 120;
    scrollTo(m, keeper, 620);
    vi.advanceTimersByTime(SHIFT_HOLD_MS + 60);
    scrollTo(m, keeper, 900); // the reader moves on
    vi.advanceTimersByTime(60);
    expect(m.scroller.scrollTop).toBe(900);
  });

  it("ignores an announced shift while no place is remembered (the reader is scrolling)", () => {
    const m = model([200, 200, 200, 200, 200, 200]);
    const keeper = settled(m, 500);
    scrollTo(m, keeper, 560); // moving
    keeper.expectShift();
    scrollTo(m, keeper, 680);
    vi.advanceTimersByTime(60);
    expect(m.scroller.scrollTop).toBe(680);
  });

  it("starts over when its row was unmounted, without jumping", () => {
    const m = model([200, 200, 200, 200, 200, 200]);
    const keeper = settled(m, 500);
    m.rows[2].remove();
    m.heights[0] = 320;
    keeper.onResize();
    expect(m.scroller.scrollTop).toBe(500);
  });

  it("takes its first place without any scroll (a list opened deep by the app)", () => {
    const m = model([200, 200, 200, 200, 200, 200]);
    m.scroller.scrollTop = 500;
    const keeper = new ViewportAnchor({ scroller: m.scroller, list: m.list });
    vi.advanceTimersByTime(SCROLL_SETTLE_MS + 20);
    m.heights[0] = 260;
    keeper.onResize();
    expect(m.scroller.scrollTop).toBe(560);
  });

  it("does nothing after dispose", () => {
    const m = model([200, 200, 200, 200, 200, 200]);
    const keeper = settled(m, 500);
    keeper.dispose();
    m.heights[0] = 320;
    keeper.onResize();
    keeper.onScroll();
    expect(m.scroller.scrollTop).toBe(500);
  });
});
