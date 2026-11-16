/**
 * The chat lists tell the virtualizer's own scrolling from the reader's by
 * wrapping `scrollBy` and `scrollTo` on the scrolling element: every pixel
 * react-virtuoso moves the list goes through one of those two, and the rest
 * of a scroll event is the reader's. The bottom pin is built on that
 * (`VirtualMessageList`: `noteVirtualizerScrolls`).
 *
 * That is a fact about the library's internals, not part of its API. These
 * tests are the guard: the dependency is pinned to an exact version, and a
 * version that moved the list some other way (by writing `scrollTop`) fails
 * here instead of quietly breaking the pin.
 *
 * Two checks, because jsdom only reaches part of the library: making room
 * for prepended rows really runs here and is measured; a jump to a row is
 * short-circuited by the library's test context and never touches the
 * element, so the second check reads the library's built source for any
 * direct write of a scroll offset.
 */
import { describe, it, expect } from "vitest";
// The client's manifest and the library's built module, as text.
import manifestRaw from "../../../../package.json?raw";
import librarySource from "../../../../node_modules/react-virtuoso/dist/index.mjs?raw";
import { createRef } from "react";
import { act, render } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { VirtualMessageList, type VirtualMessageListHandle } from "../VirtualMessageList";
import { virtualListSettled } from "@/__tests__/helpers/virtualList";

interface Msg {
  id: string;
}
const msgs = (n: number, from = 0): Msg[] => Array.from({ length: n }, (_, i) => ({ id: `m${from + i}` }));

const ROW = 50;
const VIEWPORT = 600;

/** A mounted list whose scroller has a size, so the library will scroll it. */
async function mountList(items: Msg[]) {
  const handle = createRef<VirtualMessageListHandle>();
  const scrolls: { top: number; byVirtualizer: number }[] = [];
  const ui = (rows: Msg[]) => (
    <VirtuosoMockContext.Provider value={{ viewportHeight: VIEWPORT, itemHeight: ROW }}>
      <VirtualMessageList
        items={rows}
        itemKey={(m) => m.id}
        renderItem={(m) => <div>{m.id}</div>}
        listKey="conv"
        atBottomThreshold={80}
        heightScope="contract"
        estimatedItemHeight={ROW}
        handleRef={handle}
        onScroll={(el, byVirtualizer) => scrolls.push({ top: el.scrollTop, byVirtualizer })}
      />
    </VirtuosoMockContext.Provider>
  );
  const view = render(ui(items));
  await virtualListSettled();
  const scroller = handle.current!.scroller()!;
  // jsdom lays nothing out; the library does not scroll an element of no size.
  const size = (rows: number) => {
    for (const [prop, value] of Object.entries({ offsetHeight: VIEWPORT, clientHeight: VIEWPORT, scrollHeight: rows * ROW })) {
      Object.defineProperty(scroller, prop, { value, configurable: true });
    }
  };
  size(items.length);
  scroller.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 0, bottom: VIEWPORT, width: 800, height: VIEWPORT, x: 0, y: 0, toJSON() {} }) as DOMRect;
  /** Let the scroll events of what just happened be delivered. */
  const delivered = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 50))));
  return { handle: handle.current!, scroller, scrolls, size, delivered, rerender: (rows: Msg[]) => view.rerender(ui(rows)) };
}

describe("react-virtuoso scrolls only through scrollBy / scrollTo", () => {
  it("making room for rows added above is reported as the virtualizer's own scroll", async () => {
    const first = msgs(200, 1000);
    const list = await mountList(first);
    const before = list.scroller.scrollTop;
    list.scrolls.length = 0;

    list.size(210);
    list.rerender([...msgs(10, 990), ...first]);
    await list.delivered();

    const moved = list.scroller.scrollTop - before;
    expect(moved, "the library did not scroll to make room for the new rows: this test no longer exercises it").toBe(
      10 * ROW,
    );
    const attributed = list.scrolls.reduce((sum, s) => sum + s.byVirtualizer, 0);
    expect(
      attributed,
      "react-virtuoso made room for prepended rows without calling scrollBy/scrollTo on the scroller; " +
        "VirtualMessageList's bottom pin depends on those calls (noteVirtualizerScrolls)",
    ).toBe(moved);
  });
});

describe("the react-virtuoso dependency", () => {
  it("is pinned to an exact version, so an update is a reviewed change that runs these tests", () => {
    const pkg = JSON.parse(manifestRaw) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["react-virtuoso"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("never assigns a scroll offset itself", () => {
    // It must be the real module, and one that scrolls the way we expect.
    expect(librarySource).toContain("scrollBy(");
    expect(librarySource).toContain("scrollTo(");
    // `x.scrollTop = …`, `x["scrollTop"] = …`, and the same for scrollLeft.
    const writes = librarySource.match(/(\.scroll(Top|Left)|\[\s*["']scroll(Top|Left)["']\s*\])\s*=(?!=)/g) ?? [];
    expect(
      writes,
      "react-virtuoso now writes a scroll offset directly; those scrolls bypass the scrollBy/scrollTo " +
        "wrappers VirtualMessageList uses to tell the virtualizer's scrolling from the reader's",
    ).toEqual([]);
  });
});
