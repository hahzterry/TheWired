import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { StrictMode, createRef, useState } from "react";
import { VirtuosoMockContext } from "react-virtuoso";
import {
  VirtualFeed,
  resolveInitialLocation,
  type VirtualFeedHandle,
  type VirtualFeedProps,
} from "../VirtualFeed";
import { ItemBoundary } from "@/components/ui/ErrorBoundary";
import { rememberItemHeight, resetItemHeightsForTests } from "@/lib/virtual/itemHeights";
import { FIRST_ITEM_BASE } from "@/lib/virtual/prependShift";

interface Row {
  id: string;
}
const rows = (n: number, from = 0): Row[] => Array.from({ length: n }, (_, i) => ({ id: `row-${from + i}` }));
const rowKey = (row: Row) => row.id;

/** Mounts the feed inside its own scroll parent, as the real feeds do. */
function Harness(props: Partial<VirtualFeedProps<Row>> & { items: Row[] }) {
  const [parent, setParent] = useState<HTMLDivElement | null>(null);
  return (
    <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
      <div ref={setParent} data-testid="scroller">
        <VirtualFeed
          itemKey={rowKey}
          renderItem={(row) => <div data-testid="row">{row.id}</div>}
          scrollParent={parent}
          listKey="list"
          heightScope="test"
          estimatedItemHeight={100}
          {...props}
        />
      </div>
    </VirtuosoMockContext.Provider>
  );
}

beforeEach(() => {
  resetItemHeightsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("VirtualFeed", () => {
  it("mounts only a window of a feed with thousands of rows", () => {
    render(<Harness items={rows(5000)} />);
    const mounted = screen.getAllByTestId("row");
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(60);
    expect(screen.getByText("row-0")).toBeInTheDocument();
    expect(screen.queryByText("row-4999")).toBeNull();
  });

  it("renders every row of a short feed", () => {
    render(<Harness items={rows(4)} />);
    expect(screen.getAllByTestId("row")).toHaveLength(4);
  });

  it("renders nothing until the scroll parent is known", () => {
    render(
      <VirtualFeed
        items={rows(3)}
        itemKey={rowKey}
        renderItem={(row) => <div data-testid="row">{row.id}</div>}
        scrollParent={null}
        listKey="list"
        heightScope="test"
        estimatedItemHeight={100}
      />,
    );
    expect(screen.queryByTestId("row")).toBeNull();
  });

  it("passes each row its feed index and separates rows with padding, not margin", () => {
    const seen: number[] = [];
    render(
      <Harness
        items={rows(3)}
        gap={16}
        renderItem={(row, index) => {
          seen.push(index);
          return <div data-testid="row">{row.id}</div>;
        }}
      />,
    );
    expect(new Set(seen)).toEqual(new Set([0, 1, 2]));
    const wrappers = screen.getAllByTestId("row").map((el) => el.parentElement as HTMLElement);
    expect(wrappers[0].style.paddingTop).toBe("0px");
    expect(wrappers[1].style.paddingTop).toBe("16px");
    expect(wrappers[2].style.paddingTop).toBe("16px");
  });

  it("flags rows as intro only for the first moments after mount", () => {
    vi.useFakeTimers();
    render(
      <Harness
        items={rows(3)}
        renderItem={(row, _index, intro) => (
          <div data-testid="row" data-intro={intro ? "yes" : "no"}>
            {row.id}
          </div>
        )}
      />,
    );
    expect(screen.getAllByTestId("row").every((el) => el.dataset.intro === "yes")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getAllByTestId("row").every((el) => el.dataset.intro === "no")).toBe(true);
  });

  it("reports the rendered range", () => {
    const onRangeChange = vi.fn();
    render(<Harness items={rows(5000)} onRangeChange={onRangeChange} />);
    expect(onRangeChange).toHaveBeenCalled();
    const last = onRangeChange.mock.calls[onRangeChange.mock.calls.length - 1][0];
    expect(last.startIndex).toBe(0);
    expect(last.endIndex).toBeGreaterThan(0);
    expect(last.endIndex).toBeLessThan(60);
  });

  it("asks for more while the last row is rendered and more is available", () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<Harness items={rows(5)} hasMore onLoadMore={onLoadMore} />);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    // The next page arrives and the end is still in the window: ask again.
    rerender(<Harness items={rows(7)} hasMore onLoadMore={onLoadMore} />);
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });

  it("does not ask for more when nothing more is available or the end is far away", () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<Harness items={rows(5)} hasMore={false} onLoadMore={onLoadMore} />);
    expect(onLoadMore).not.toHaveBeenCalled();
    rerender(<Harness items={rows(5000)} hasMore onLoadMore={onLoadMore} />);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("asks for more as soon as more becomes available while the end is on screen", () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<Harness items={rows(5)} hasMore={false} onLoadMore={onLoadMore} />);
    rerender(<Harness items={rows(5)} hasMore onLoadMore={onLoadMore} />);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("scrollToKey: null for an unknown row, true for a known one", () => {
    const handle = createRef<VirtualFeedHandle>();
    render(<Harness items={rows(5000)} handleRef={handle} />);
    expect(handle.current!.scrollToKey("nope")).toBeNull();
    expect(handle.current!.scrollToKey("row-3000", 24)).toBe(true);
  });

  it("does not paint the top of the feed while opening on a saved row", () => {
    // It scrolls its parent to the saved row first and keeps the rows hidden
    // until that lands. (Landing needs real layout; covered by the e2e suite.)
    render(<Harness items={rows(5000)} initialAnchor={{ key: "row-3000", offset: 0 }} />);
    expect(screen.queryByText("row-0")).toBeNull();
  });

  it("starts at the top when the saved row is gone", () => {
    render(<Harness items={rows(5000)} initialAnchor={{ key: "gone", offset: 12 }} />);
    expect(screen.getByText("row-0")).toBeInTheDocument();
  });

  it("starts a fresh window when the list key changes", () => {
    const { rerender } = render(
      <Harness items={rows(5000)} listKey="a" initialAnchor={{ key: "row-3000", offset: 0 }} />,
    );
    expect(screen.queryByText("row-0")).toBeNull();
    rerender(<Harness items={rows(5000)} listKey="b" initialAnchor={null} />);
    expect(screen.getByText("row-0")).toBeInTheDocument();
  });

  it("remembers measured row heights under the given scope", async () => {
    const { peekItemHeight } = await import("@/lib/virtual/itemHeights");
    render(<Harness items={rows(3)} heightScope="mem" />);
    expect(peekItemHeight("mem", "row-0")).toBe(100);
    expect(peekItemHeight("other", "row-0")).toBeUndefined();
  });

  it("mounts with remembered heights without throwing", () => {
    rememberItemHeight("test", "row-1", 480);
    render(<Harness items={rows(20)} />);
    expect(screen.getByText("row-0")).toBeInTheDocument();
  });

  it("a throwing row shows its inline fallback and leaves its neighbours mounted", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Card({ row }: { row: Row }) {
      if (row.id === "row-2") throw new Error("card exploded");
      return <div data-testid="row">{row.id}</div>;
    }
    render(
      <Harness
        items={rows(5)}
        renderItem={(row) => (
          <ItemBoundary id={row.id} label="test-row" noun="note">
            <Card row={row} />
          </ItemBoundary>
        )}
      />,
    );
    expect(screen.getByText("row-1")).toBeInTheDocument();
    expect(screen.getByText("row-3")).toBeInTheDocument();
    expect(screen.queryByText("row-2")).toBeNull();
    const fallbacks = screen.getAllByRole("status");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toHaveTextContent("This note couldn't be displayed.");
    expect(screen.getAllByTestId("row")).toHaveLength(4);
  });

  it("keeps rows keyed by their id when the feed grows at the top", () => {
    const mounts: string[] = [];
    function Card({ row }: { row: Row }) {
      useState(() => mounts.push(row.id));
      return <div data-testid="row">{row.id}</div>;
    }
    const first = rows(3);
    const { rerender } = render(<Harness items={first} renderItem={(row) => <Card row={row} />} />);
    expect(mounts).toEqual(["row-0", "row-1", "row-2"]);
    rerender(<Harness items={[{ id: "new" }, ...first]} renderItem={(row) => <Card row={row} />} />);
    // Existing cards were moved, not remounted.
    expect(mounts).toEqual(["row-0", "row-1", "row-2", "new"]);
  });
});

/**
 * A row added at the head of a feed. Whether the reader keeps their place or
 * sees the row push in depends on where they are, and has to come out the
 * same however many times React renders the change (Strict Mode renders
 * everything twice).
 */
describe("VirtualFeed rows added at the head", () => {
  const virtualIndexOf = (text: string) =>
    Number(screen.getByText(text).closest("[data-item-index]")!.getAttribute("data-item-index"));

  /** Put the top of the list `px` above the top of its scroll parent. */
  function scrollListUp(px: number) {
    const scroller = screen.getByTestId("scroller");
    const wrapper = scroller.firstElementChild as HTMLElement;
    const rect = (top: number) => ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON() {} });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(rect(0) as DOMRect);
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue(rect(-px) as DOMRect);
    act(() => void scroller.dispatchEvent(new Event("scroll")));
  }

  it("Strict Mode: a reader further down keeps their place, the index moving by exactly the rows added", () => {
    const first = rows(3);
    const { rerender } = render(
      <StrictMode>
        <Harness items={first} />
      </StrictMode>,
    );
    scrollListUp(500);
    rerender(
      <StrictMode>
        <Harness items={[{ id: "new-1" }, ...first]} />
      </StrictMode>,
    );
    // The rows on screen keep their indexes (so they do not move); the new
    // row took the index above them.
    expect(virtualIndexOf("row-0")).toBe(FIRST_ITEM_BASE);
    expect(virtualIndexOf("row-2")).toBe(FIRST_ITEM_BASE + 2);
    // Each arrival is counted once.
    rerender(
      <StrictMode>
        <Harness items={[{ id: "new-3" }, { id: "new-2" }, { id: "new-1" }, ...first]} />
      </StrictMode>,
    );
    expect(virtualIndexOf("row-0")).toBe(FIRST_ITEM_BASE);
    expect(virtualIndexOf("row-2")).toBe(FIRST_ITEM_BASE + 2);
  });

  it("Strict Mode: with the top of the list in view the new row pushes in", () => {
    const first = rows(3);
    const { rerender } = render(
      <StrictMode>
        <Harness items={first} />
      </StrictMode>,
    );
    rerender(
      <StrictMode>
        <Harness items={[{ id: "new-1" }, ...first]} />
      </StrictMode>,
    );
    expect(virtualIndexOf("new-1")).toBe(FIRST_ITEM_BASE);
    expect(virtualIndexOf("row-0")).toBe(FIRST_ITEM_BASE + 1);
  });

  it("goes back to pushing rows in once the reader returns to the top", () => {
    const first = rows(3);
    const { rerender } = render(<Harness items={first} />);
    scrollListUp(500);
    scrollListUp(0);
    rerender(<Harness items={[{ id: "new-1" }, ...first]} />);
    expect(virtualIndexOf("new-1")).toBe(FIRST_ITEM_BASE);
    expect(virtualIndexOf("row-0")).toBe(FIRST_ITEM_BASE + 1);
  });

  it("does not measure the page while rendering", () => {
    const first = rows(3);
    const { rerender } = render(<Harness items={first} />);
    const scroller = screen.getByTestId("scroller");
    let rendering = false;
    let measuredInRender = 0;
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (rendering && (this === scroller || this === scroller.firstElementChild)) measuredInRender++;
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    });
    rerender(
      <Harness
        items={[{ id: "new-1" }, ...first]}
        renderItem={(row) => {
          // Rows render inside the list's own render pass.
          rendering = true;
          queueMicrotask(() => (rendering = false));
          return <div data-testid="row">{row.id}</div>;
        }}
      />,
    );
    spy.mockRestore();
    expect(measuredInRender).toBe(0);
  });
});

describe("resolveInitialLocation", () => {
  const keys = ["a", "b", "c"];

  it("opens on the saved row with its offset", () => {
    expect(resolveInitialLocation(keys, { key: "c", offset: 37 })).toEqual({ index: 2, align: "start", offset: 37 });
  });

  it("opens part-way into the first row when it was scrolled into", () => {
    expect(resolveInitialLocation(keys, { key: "a", offset: 12 })).toEqual({ index: 0, align: "start", offset: 12 });
  });

  it("adds the gap above a row, which is not part of the row's content", () => {
    expect(resolveInitialLocation(keys, { key: "c", offset: 37 }, 16)).toEqual({ index: 2, align: "start", offset: 53 });
    // The first row has no gap above it.
    expect(resolveInitialLocation(keys, { key: "a", offset: 12 }, 16)).toEqual({ index: 0, align: "start", offset: 12 });
  });

  it("opens at the top with no saved row, a missing row, or the untouched first row", () => {
    expect(resolveInitialLocation(keys, null)).toBeUndefined();
    expect(resolveInitialLocation(keys, { key: "gone", offset: 5 })).toBeUndefined();
    expect(resolveInitialLocation(keys, { key: "a", offset: 0 })).toBeUndefined();
  });
});
