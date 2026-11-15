import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StrictMode, createElement } from "react";
import { act, render, renderHook } from "@testing-library/react";
import {
  captureScrollPosition,
  resolveAnchorTop,
  resolveScrollTop,
  useAnchoredScrollRestore,
  type SavedScrollPosition,
} from "../useAnchoredScrollRestore";

const ATTR = "data-feed-anchor";

/**
 * jsdom doesn't lay out, so we stub geometry. Each card lives at a fixed
 * *content* top; getBoundingClientRect returns viewport coords
 * (contentTop - scrollTop), exactly like a real scroll container.
 */
function makeContainer(): HTMLDivElement {
  const container = document.createElement("div");
  Object.defineProperty(container, "getBoundingClientRect", {
    value: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    configurable: true,
  });
  // jsdom scrollTop is a plain settable number — good enough.
  container.scrollTop = 0;
  document.body.appendChild(container);
  return container;
}

function addCard(container: HTMLElement, id: string, contentTop: number, height = 100) {
  const el = document.createElement("div");
  el.setAttribute(ATTR, id);
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({
      top: contentTop - container.scrollTop,
      left: 0,
      right: 0,
      bottom: contentTop - container.scrollTop + height,
      width: 0,
      height,
    }),
    configurable: true,
  });
  container.appendChild(el);
  return el;
}

describe("captureScrollPosition", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("anchors to the card the viewport top is sitting on, with the px offset", () => {
    const c = makeContainer();
    addCard(c, "a", 0);
    addCard(c, "b", 100);
    addCard(c, "c", 200);
    addCard(c, "d", 300);
    c.scrollTop = 250; // viewport top is 50px into card "c"

    expect(captureScrollPosition(c, ATTR)).toEqual({
      scrollTop: 250,
      anchorId: "c",
      anchorOffset: 50,
    });
  });

  it("falls back to pixel-only when the viewport is above the first card (header)", () => {
    const c = makeContainer();
    // Cards start 500px down (below a profile header).
    addCard(c, "a", 500);
    addCard(c, "b", 600);
    c.scrollTop = 100;

    expect(captureScrollPosition(c, ATTR)).toEqual({ scrollTop: 100 });
  });

  it("returns scrollTop only when no card attribute is given", () => {
    const c = makeContainer();
    addCard(c, "a", 0);
    c.scrollTop = 42;
    expect(captureScrollPosition(c)).toEqual({ scrollTop: 42 });
  });

  it("picks the last card at/above the fold top, not a card below it", () => {
    const c = makeContainer();
    addCard(c, "a", 0);
    addCard(c, "b", 100);
    addCard(c, "c", 200);
    c.scrollTop = 100; // exactly the top of "b"
    const pos = captureScrollPosition(c, ATTR);
    expect(pos.anchorId).toBe("b");
    expect(pos.anchorOffset).toBe(0);
  });
});

describe("resolveScrollTop", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns the scrollTop that puts the anchor card back at the same offset", () => {
    const c = makeContainer();
    addCard(c, "a", 0);
    addCard(c, "b", 100);
    addCard(c, "c", 200);

    const target = resolveScrollTop(
      c,
      { scrollTop: 250, anchorId: "c", anchorOffset: 50 },
      ATTR,
    );
    expect(target).toBe(250); // card "c" at content-top 200 + 50 offset
  });

  it("tracks the anchor when content above it grew (immune to height shift)", () => {
    const c = makeContainer();
    addCard(c, "a", 0);
    addCard(c, "b", 100);
    // Card "c" was at 200 when saved; an image above loaded and pushed it to 600.
    addCard(c, "c", 600);

    const target = resolveScrollTop(
      c,
      { scrollTop: 250, anchorId: "c", anchorOffset: 50 },
      ATTR,
    );
    expect(target).toBe(650); // re-pins to the card's *current* position
  });

  it("falls back to the saved pixel offset when the anchor card is gone", () => {
    const c = makeContainer();
    addCard(c, "a", 0);

    const target = resolveScrollTop(
      c,
      { scrollTop: 250, anchorId: "missing", anchorOffset: 50 },
      ATTR,
    );
    expect(target).toBe(250);
  });

  it("uses the pixel offset when there is no anchor id", () => {
    const c = makeContainer();
    expect(resolveScrollTop(c, { scrollTop: 123 }, ATTR)).toBe(123);
  });
});

describe("resolveAnchorTop", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("is null when the anchor card is not rendered (virtualized list)", () => {
    const c = makeContainer();
    addCard(c, "a", 0);
    expect(resolveAnchorTop(c, { scrollTop: 900, anchorId: "far", anchorOffset: 10 }, ATTR)).toBeNull();
    expect(resolveAnchorTop(c, { scrollTop: 900 }, ATTR)).toBeNull();
  });

  it("is the card's live position plus the saved offset when it is rendered", () => {
    const c = makeContainer();
    addCard(c, "a", 0);
    addCard(c, "b", 340);
    expect(resolveAnchorTop(c, { scrollTop: 1, anchorId: "b", anchorOffset: 25 }, ATTR)).toBe(365);
  });
});

describe("useAnchoredScrollRestore with a virtualized list", () => {
  // Animation frames run by hand; cancelling one really removes it.
  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;

  beforeEach(() => {
    document.body.innerHTML = "";
    frames = new Map();
    nextFrameId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Run the queued animation frames, `n` rounds. */
  function runFrames(n = 1) {
    for (let i = 0; i < n; i++) {
      const batch = [...frames.values()];
      frames.clear();
      for (const cb of batch) cb(0);
    }
  }

  function mount(saved: SavedScrollPosition, scrollToAnchor: (id: string, offset: number) => boolean | null) {
    const container = makeContainer();
    const hook = renderHook(() =>
      useAnchoredScrollRestore({
        key: "feed",
        read: () => saved,
        write: () => {},
        cardAttr: ATTR,
        scrollToAnchor,
      }),
    );
    act(() => hook.result.current.containerRef(container));
    return container;
  }

  it("asks the list for a card that is not rendered instead of applying the pixel offset", () => {
    const ask = vi.fn(() => true);
    const c = mount({ scrollTop: 9000, anchorId: "far", anchorOffset: 30 }, ask);
    expect(ask).toHaveBeenCalledWith("far", 30);
    // No clamped pixel jump while the list brings the card in.
    expect(c.scrollTop).toBe(0);
  });

  it("pins to the card once the list has rendered it", () => {
    const ask = vi.fn(() => true);
    const c = mount({ scrollTop: 9000, anchorId: "far", anchorOffset: 30 }, ask);
    runFrames(2);
    addCard(c, "far", 4200);
    runFrames(1);
    expect(c.scrollTop).toBe(4230);
    // The card moved (rows above it were measured): it follows.
    c.replaceChildren();
    addCard(c, "far", 4500);
    runFrames(1);
    expect(c.scrollTop).toBe(4530);
  });

  it("keeps asking while the list is not ready, then stops once the request is made", () => {
    let ready = false;
    const ask = vi.fn(() => ready);
    mount({ scrollTop: 9000, anchorId: "far", anchorOffset: 0 }, ask);
    runFrames(3);
    expect(ask).toHaveBeenCalledTimes(4); // on restore + once per frame
    ready = true;
    runFrames(1);
    expect(ask).toHaveBeenCalledTimes(5);
    runFrames(5);
    expect(ask).toHaveBeenCalledTimes(5); // waiting for the card to render
  });

  it("falls back to the pixel offset when the card is no longer in the list", () => {
    const ask = vi.fn(() => null);
    const c = mount({ scrollTop: 640, anchorId: "deleted", anchorOffset: 30 }, ask);
    expect(c.scrollTop).toBe(640);
    runFrames(3);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("does not ask the list when the card is already in the DOM", () => {
    const ask = vi.fn(() => true);
    const container = makeContainer();
    addCard(container, "near", 300);
    const hook = renderHook(() =>
      useAnchoredScrollRestore({
        key: "feed",
        read: () => ({ scrollTop: 320, anchorId: "near", anchorOffset: 20 }),
        write: () => {},
        cardAttr: ATTR,
        scrollToAnchor: ask,
      }),
    );
    act(() => hook.result.current.containerRef(container));
    expect(container.scrollTop).toBe(320);
    expect(ask).not.toHaveBeenCalled();
  });

  it("keeps re-pinning after StrictMode's mount-time effect replay", () => {
    // React (development) runs the unmount cleanup once right after mount,
    // which cancelled the loop started when the container attached during
    // that same mount.
    const ask = vi.fn(() => true);
    function Feed() {
      const { containerRef } = useAnchoredScrollRestore({
        key: "feed",
        read: () => ({ scrollTop: 9000, anchorId: "far", anchorOffset: 30 }),
        write: () => {},
        cardAttr: ATTR,
        scrollToAnchor: ask,
      });
      return createElement("div", { ref: containerRef, "data-testid": "feed" });
    }
    const { getByTestId } = render(createElement(StrictMode, null, createElement(Feed)));
    const container = getByTestId("feed") as HTMLDivElement;
    runFrames(2);
    addCard(container, "far", 4200);
    runFrames(2);
    expect(container.scrollTop).toBe(4230);
  });

  it("starts at the top with no saved position", () => {
    const ask = vi.fn(() => true);
    const container = makeContainer();
    container.scrollTop = 500;
    const hook = renderHook(() =>
      useAnchoredScrollRestore({
        key: "feed",
        read: () => undefined,
        write: () => {},
        cardAttr: ATTR,
        scrollToAnchor: ask,
      }),
    );
    act(() => hook.result.current.containerRef(container));
    expect(container.scrollTop).toBe(0);
    expect(ask).not.toHaveBeenCalled();
  });
});
