import { describe, it, expect, vi } from "vitest";
import { onVirtualizerScroll } from "../virtualizerScrolls";

function scroller(): HTMLDivElement {
  const el = document.createElement("div");
  el.scrollTop = 100;
  return el;
}

describe("onVirtualizerScroll", () => {
  it("reports each scrollBy and scrollTo with how far the element moved", () => {
    const el = scroller();
    const heard = vi.fn();
    onVirtualizerScroll(el, heard);
    el.scrollBy({ top: 40 });
    el.scrollTo({ top: 10 });
    expect(heard.mock.calls).toEqual([
      [40, "scrollBy"],
      [-130, "scrollTo"],
    ]);
    expect(el.scrollTop).toBe(10);
  });

  it("is called inside the call, after the element has moved", () => {
    const el = scroller();
    const seen: number[] = [];
    onVirtualizerScroll(el, () => seen.push(el.scrollTop));
    el.scrollBy({ top: 25 });
    expect(seen).toEqual([125]);
  });

  it("says nothing about plain scrollTop writes (the reader, the browser, the app)", () => {
    const el = scroller();
    const heard = vi.fn();
    onVirtualizerScroll(el, heard);
    el.scrollTop = 300;
    expect(heard).not.toHaveBeenCalled();
  });

  it("serves several listeners from one wrapping of the element, each with its own unsubscribe", () => {
    const el = scroller();
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = onVirtualizerScroll(el, first);
    const wrapped = el.scrollBy;
    onVirtualizerScroll(el, second);
    expect(el.scrollBy).toBe(wrapped); // not wrapped a second time
    el.scrollBy({ top: 5 });
    stopFirst();
    el.scrollBy({ top: 5 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(el.scrollTop).toBe(110); // each call moved the element once
  });

  it("a listener may scroll the element itself without being lost or looping", () => {
    const el = scroller();
    const heard: number[] = [];
    let undoing = false;
    onVirtualizerScroll(el, (delta) => {
      heard.push(delta);
      if (undoing) return;
      undoing = true;
      el.scrollBy({ top: -delta }); // put it back, the way the anchor keeper does
      undoing = false;
    });
    el.scrollBy({ top: 60 });
    expect(heard).toEqual([60, -60]);
    expect(el.scrollTop).toBe(100);
  });
});
