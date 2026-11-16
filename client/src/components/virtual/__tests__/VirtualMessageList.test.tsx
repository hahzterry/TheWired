import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, Suspense, createRef, startTransition, use, useState } from "react";
import { VirtuosoMockContext } from "react-virtuoso";
import {
  VirtualMessageList,
  type VirtualMessageListHandle,
  type VirtualMessageListProps,
} from "../VirtualMessageList";
import { ItemBoundary } from "@/components/ui/ErrorBoundary";
import { FIRST_ITEM_BASE } from "@/lib/virtual/prependShift";
import { resetItemHeightsForTests } from "@/lib/virtual/itemHeights";
import {
  captureResizeObservers,
  setScrollGeometry,
  userScrollTo,
  virtualizerScrollTo,
  virtualListContent,
  virtualListSettled,
} from "@/__tests__/helpers/virtualList";

interface Msg {
  id: string;
}
const msgs = (n: number, from = 0): Msg[] => Array.from({ length: n }, (_, i) => ({ id: `m${from + i}` }));
const msgKey = (m: Msg) => m.id;

function List(props: Partial<VirtualMessageListProps<Msg>> & { items: Msg[] }) {
  return (
    <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 50 }}>
      <VirtualMessageList
        itemKey={msgKey}
        renderItem={(m, index) => (
          <div data-testid="msg" data-position={index}>
            {m.id}
          </div>
        )}
        listKey="conv"
        atBottomThreshold={80}
        heightScope="test-msgs"
        estimatedItemHeight={50}
        {...props}
      />
    </VirtuosoMockContext.Provider>
  );
}

/** The virtualizer's own index of each mounted row (counts from firstItemIndex). */
function virtualIndexes(container: HTMLElement): number[] {
  return [...container.querySelectorAll("[data-item-index]")].map((el) => Number(el.getAttribute("data-item-index")));
}

/** The list shows its rows once its opening scroll has landed. */
const settled = () => virtualListSettled();

type Geometry = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** The reader scrolls the list to `scrollTop` (wheel input, then the scroll). */
function scrollTo(container: HTMLElement, geometry: Geometry) {
  const scroller = container.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement;
  act(() => userScrollTo(scroller, geometry));
  return scroller;
}

/** A scroll with no input behind it: a script, the scrollbar, the browser. */
function plainScroll(container: HTMLElement, geometry: Geometry) {
  const scroller = container.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement;
  act(() => setScrollGeometry(scroller, geometry));
  return scroller;
}

/** The virtualizer moves the list itself. */
async function movedByList(container: HTMLElement, geometry: Geometry) {
  const scroller = container.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement;
  await virtualizerScrollTo(scroller, geometry);
  return scroller;
}

/** The virtualizer's index of the row showing `text`. */
function virtualIndexOf(text: string): number {
  const row = screen.getByText(text).closest("[data-item-index]")!;
  return Number(row.getAttribute("data-item-index"));
}

beforeEach(() => resetItemHeightsForTests());
afterEach(() => vi.restoreAllMocks());

describe("VirtualMessageList", () => {
  it("mounts only a window of a conversation with thousands of messages", async () => {
    render(<List items={msgs(5000)} />);
    const mounted = await screen.findAllByTestId("msg");
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(80);
    // It opens on the newest message, not the oldest.
    expect(screen.getByText("m4999")).toBeInTheDocument();
    expect(screen.queryByText("m0")).toBeNull();
  });

  it("gives rows their plain list position, whatever the virtualizer counts from", async () => {
    render(<List items={msgs(3)} />);
    await settled();
    expect(screen.getAllByTestId("msg").map((el) => el.dataset.position)).toEqual(["0", "1", "2"]);
  });

  it("keeps the rows on screen where they are when history arrives above them", async () => {
    const first = msgs(3, 100); // m100..m102
    const { container, rerender } = render(<List items={first} />);
    await settled();
    expect(virtualIndexes(container)).toEqual([FIRST_ITEM_BASE, FIRST_ITEM_BASE + 1, FIRST_ITEM_BASE + 2]);

    // Two older messages arrive at the head.
    rerender(<List items={[...msgs(2, 98), ...first]} />);
    // The virtualizer was told two rows were prepended: the rows that were on
    // screen keep their indexes (so they do not move), and the older ones take
    // the two indexes below.
    expect(virtualIndexOf("m100")).toBe(FIRST_ITEM_BASE);
    expect(virtualIndexOf("m102")).toBe(FIRST_ITEM_BASE + 2);
    await waitFor(() => expect(virtualIndexOf("m98")).toBe(FIRST_ITEM_BASE - 2));
  });

  it("does not shift anything when a message is appended", async () => {
    const first = msgs(3);
    const { container, rerender } = render(<List items={first} />);
    await settled();
    rerender(<List items={[...first, { id: "new" }]} />);
    expect(virtualIndexes(container)[0]).toBe(FIRST_ITEM_BASE);
  });

  it("follows a message appended while the reader is at the bottom", async () => {
    const shouldFollow = vi.fn(({ atBottom }: { atBottom: boolean }) => atBottom);
    const onMissedAppend = vi.fn();
    const first = msgs(3);
    const { rerender } = render(<List items={first} shouldFollow={shouldFollow} onMissedAppend={onMissedAppend} />);
    await settled();
    rerender(<List items={[...first, { id: "new" }]} shouldFollow={shouldFollow} onMissedAppend={onMissedAppend} />);
    expect(shouldFollow).toHaveBeenCalledTimes(1);
    expect(shouldFollow.mock.calls[0][0]).toMatchObject({ atBottom: true, last: { id: "new" } });
    expect(onMissedAppend).not.toHaveBeenCalled();
  });

  it("reports a missed append when the reader is up in history, and leaves them there", async () => {
    const onMissedAppend = vi.fn();
    const onAtBottomChange = vi.fn();
    const first = msgs(200);
    const { container, rerender } = render(
      <List items={first} onMissedAppend={onMissedAppend} onAtBottomChange={onAtBottomChange} />,
    );
    await settled();
    scrollTo(container, { scrollTop: 9400, scrollHeight: 10_000, clientHeight: 600 }); // at the end
    scrollTo(container, { scrollTop: 1000, scrollHeight: 10_000, clientHeight: 600 }); // up into history
    expect(onAtBottomChange).toHaveBeenLastCalledWith(false);

    rerender(
      <List items={[...first, { id: "new" }]} onMissedAppend={onMissedAppend} onAtBottomChange={onAtBottomChange} />,
    );
    expect(onMissedAppend).toHaveBeenCalledTimes(1);
  });

  it("does not treat history at the head, an edit or a deletion as a new message", async () => {
    const shouldFollow = vi.fn(() => true);
    const onMissedAppend = vi.fn();
    const first = msgs(5, 10);
    const props = { shouldFollow, onMissedAppend };
    const { rerender } = render(<List items={first} {...props} />);
    await settled();
    rerender(<List items={[...msgs(3, 7), ...first]} {...props} />); // history
    rerender(<List items={[...msgs(3, 7), ...first].map((m) => ({ ...m }))} {...props} />); // edit: same keys
    rerender(<List items={[...msgs(3, 7), ...first.slice(0, 4)]} {...props} />); // newest deleted
    expect(shouldFollow).not.toHaveBeenCalled();
    expect(onMissedAppend).not.toHaveBeenCalled();
  });

  it("lets the caller always follow its own send", async () => {
    const onMissedAppend = vi.fn();
    const first = msgs(200);
    const follow = ({ last }: { last: Msg }) => last.id.startsWith("temp");
    const { container, rerender } = render(<List items={first} shouldFollow={follow} onMissedAppend={onMissedAppend} />);
    await settled();
    scrollTo(container, { scrollTop: 9400, scrollHeight: 10_000, clientHeight: 600 });
    scrollTo(container, { scrollTop: 1000, scrollHeight: 10_000, clientHeight: 600 });
    rerender(<List items={[...first, { id: "temp-1" }]} shouldFollow={follow} onMissedAppend={onMissedAppend} />);
    expect(onMissedAppend).not.toHaveBeenCalled();
  });

  it("reports reaching and leaving the bottom from scroll geometry and the threshold", async () => {
    const onAtBottomChange = vi.fn();
    const handle = createRef<VirtualMessageListHandle>();
    const { container } = render(<List items={msgs(200)} onAtBottomChange={onAtBottomChange} handleRef={handle} />);
    await settled();
    expect(handle.current!.isAtBottom()).toBe(true);
    onAtBottomChange.mockClear();

    scrollTo(container, { scrollTop: 9400, scrollHeight: 10_000, clientHeight: 600 }); // at the end
    scrollTo(container, { scrollTop: 9319, scrollHeight: 10_000, clientHeight: 600 }); // up to 81px from the end
    expect(onAtBottomChange).toHaveBeenLastCalledWith(false);
    expect(handle.current!.isAtBottom()).toBe(false);

    scrollTo(container, { scrollTop: 9321, scrollHeight: 10_000, clientHeight: 600 }); // 79px from the end
    expect(onAtBottomChange).toHaveBeenLastCalledWith(true);
    expect(onAtBottomChange).toHaveBeenCalledTimes(2);

    // Within the threshold counts as at the bottom, even when moving up.
    scrollTo(container, { scrollTop: 9325, scrollHeight: 10_000, clientHeight: 600 });
    expect(onAtBottomChange).toHaveBeenCalledTimes(2);
  });

  it("still follows after a scroll event caused by history being prepended", async () => {
    const onMissedAppend = vi.fn();
    const onAtBottomChange = vi.fn();
    const first = msgs(200, 1000);
    const props = { onMissedAppend, onAtBottomChange };
    const { container, rerender } = render(<List items={first} {...props} />);
    await settled();
    // At the bottom.
    scrollTo(container, { scrollTop: 9400, scrollHeight: 10_000, clientHeight: 600 });
    // History arrives: the list is scrolled DOWN by the added height while its
    // total height is not final yet, so for a moment it is not "at the end".
    rerender(<List items={[...msgs(500, 500), ...first]} {...props} />);
    await movedByList(container, { scrollTop: 37_400, scrollHeight: 38_300, clientHeight: 600 });
    expect(onAtBottomChange).not.toHaveBeenCalledWith(false);
    // A message arriving now is followed, not missed.
    rerender(<List items={[...msgs(500, 500), ...first, { id: "new" }]} {...props} />);
    expect(onMissedAppend).not.toHaveBeenCalled();
  });

  it("is not released by the virtualizer correcting its own offset upwards", async () => {
    const onMissedAppend = vi.fn();
    const onAtBottomChange = vi.fn();
    const first = msgs(200);
    const props = { onMissedAppend, onAtBottomChange };
    const { container, rerender } = render(<List items={first} {...props} />);
    await settled(); // opened at the end
    plainScroll(container, { scrollTop: 9400, scrollHeight: 10_000, clientHeight: 600 });
    // Rows above are measured again (the window was resized) and the
    // virtualizer scrolls up by the difference: the end is now 118px away.
    const scroller = await movedByList(container, { scrollTop: 9082, scrollHeight: 10_000, clientHeight: 800 });
    expect(onAtBottomChange).not.toHaveBeenCalledWith(false);
    // ...and the list puts itself back on the newest row.
    expect(scroller.scrollTop).toBe(10_000);
    rerender(<List items={[...first, { id: "new" }]} {...props} />);
    expect(onMissedAppend).not.toHaveBeenCalled();
  });

  it("a slow upward scroll inside the threshold is not pulled back when rows are measured", async () => {
    const resizes = captureResizeObservers();
    try {
      const { container } = render(<List items={msgs(200)} />);
      await settled();
      const scroller = plainScroll(container, { scrollTop: 9400, scrollHeight: 10_000, clientHeight: 600 }); // the end
      const content = virtualListContent(container);

      // Content resizes while holding the end: the list keeps to it. (jsdom
      // does not clamp or emit the scroll that follows; a browser would land
      // on 9,500 and say so.)
      Object.defineProperty(content, "offsetHeight", { value: 10_100, configurable: true });
      Object.defineProperty(scroller, "scrollHeight", { value: 10_100, configurable: true });
      act(() => resizes.fire(content));
      expect(scroller.scrollTop).toBe(10_100);
      plainScroll(container, { scrollTop: 9500, scrollHeight: 10_100, clientHeight: 600 });

      // The reader moves up 30px (still "at the bottom" for following), and
      // rows above are measured: the list must not drag them back.
      plainScroll(container, { scrollTop: 9470, scrollHeight: 10_100, clientHeight: 600 });
      Object.defineProperty(content, "offsetHeight", { value: 10_220, configurable: true });
      Object.defineProperty(scroller, "scrollHeight", { value: 10_220, configurable: true });
      act(() => resizes.fire(content));
      expect(scroller.scrollTop).toBe(9470);

      // Back down to the very end: it holds again.
      plainScroll(container, { scrollTop: 9620, scrollHeight: 10_220, clientHeight: 600 });
      Object.defineProperty(content, "offsetHeight", { value: 10_300, configurable: true });
      Object.defineProperty(scroller, "scrollHeight", { value: 10_300, configurable: true });
      act(() => resizes.fire(content));
      expect(scroller.scrollTop).toBe(10_300);
    } finally {
      resizes.restore();
    }
  });

  it("is released by any other upward scroll, with or without input (wheel, scrollbar, script)", async () => {
    const onAtBottomChange = vi.fn();
    const { container } = render(<List items={msgs(200)} onAtBottomChange={onAtBottomChange} />);
    await settled();
    plainScroll(container, { scrollTop: 9400, scrollHeight: 10_000, clientHeight: 600 });
    plainScroll(container, { scrollTop: 4000, scrollHeight: 10_000, clientHeight: 600 });
    expect(onAtBottomChange).toHaveBeenLastCalledWith(false);
    // It is never dragged back to the end while the reader keeps scrolling.
    const scroller = plainScroll(container, { scrollTop: 3000, scrollHeight: 10_000, clientHeight: 600 });
    expect(scroller.scrollTop).toBe(3000);
  });

  it("a jump to an older row releases the bottom; a jump to the newest row does not", async () => {
    const onAtBottomChange = vi.fn();
    const handle = createRef<VirtualMessageListHandle>();
    render(<List items={msgs(300)} onAtBottomChange={onAtBottomChange} handleRef={handle} />);
    await settled();
    act(() => {
      handle.current!.scrollToKey("m299");
    });
    expect(handle.current!.isAtBottom()).toBe(true);
    act(() => {
      handle.current!.scrollToKey("m10");
    });
    expect(handle.current!.isAtBottom()).toBe(false);
    expect(onAtBottomChange).toHaveBeenLastCalledWith(false);
  });

  it("tells the caller how much of a scroll was the virtualizer's own", async () => {
    const onScroll = vi.fn();
    const { container } = render(<List items={msgs(50)} onScroll={onScroll} />);
    await settled();
    // The reader leaves the end first, so nothing pulls the list back to it.
    plainScroll(container, { scrollTop: 1900, scrollHeight: 2500, clientHeight: 600 });
    const scroller = plainScroll(container, { scrollTop: 100, scrollHeight: 2500, clientHeight: 600 });
    // The virtualizer moves the list 60px up.
    await movedByList(container, { scrollTop: 40, scrollHeight: 2500, clientHeight: 600 });
    expect(onScroll).toHaveBeenLastCalledWith(scroller, -60);
    // The reader scrolls 30px up: none of it is the virtualizer's.
    scrollTo(container, { scrollTop: 10, scrollHeight: 2500, clientHeight: 600 });
    expect(onScroll).toHaveBeenLastCalledWith(scroller, 0);
  });

  it("separates the reader's part when both moved the list before one scroll event", async () => {
    const onScroll = vi.fn();
    const onAtBottomChange = vi.fn();
    const { container } = render(<List items={msgs(200)} onScroll={onScroll} onAtBottomChange={onAtBottomChange} />);
    await settled();
    const scroller = plainScroll(container, { scrollTop: 9400, scrollHeight: 10_000, clientHeight: 600 });
    // Within one frame the virtualizer compensates +150 (rows above measured
    // taller) and the reader's wheel moves the list 300 up. One scroll event
    // follows, showing a net -150.
    scroller.scrollBy({ top: 150 });
    scroller.scrollTop -= 300;
    onScroll.mockClear();
    await act(async () => {
      await Promise.resolve();
    });
    expect(onScroll).toHaveBeenLastCalledWith(scroller, 150);
    // The reader's 300px up released the bottom, though the net move was 150.
    expect(onAtBottomChange).toHaveBeenLastCalledWith(false);
  });

  it("opens away from the bottom when given an initial row", async () => {
    const handle = createRef<VirtualMessageListHandle>();
    render(<List items={msgs(200)} initialRow={{ key: "m120", align: "center" }} handleRef={handle} />);
    expect(handle.current!.isAtBottom()).toBe(false);
  });

  it("opens at the bottom when the initial row is not in the list", async () => {
    const handle = createRef<VirtualMessageListHandle>();
    render(<List items={msgs(200)} initialRow={{ key: "gone", align: "center" }} handleRef={handle} />);
    expect(handle.current!.isAtBottom()).toBe(true);
  });

  it("scrollToKey: false for an unknown row, true for a known one", async () => {
    const handle = createRef<VirtualMessageListHandle>();
    render(<List items={msgs(5000)} handleRef={handle} />);
    await settled();
    expect(handle.current!.scrollToKey("nope")).toBe(false);
    expect(handle.current!.scrollToKey("m4000")).toBe(true);
    expect(() => handle.current!.scrollToBottom("smooth")).not.toThrow();
  });

  it("passes every scroll to the caller and exposes the scroller", async () => {
    const onScroll = vi.fn();
    const handle = createRef<VirtualMessageListHandle>();
    const { container } = render(<List items={msgs(50)} onScroll={onScroll} handleRef={handle} />);
    await settled();
    const scroller = scrollTo(container, { scrollTop: 10, scrollHeight: 2500, clientHeight: 600 });
    expect(onScroll).toHaveBeenCalledWith(scroller, 0);
    expect(handle.current!.scroller()).toBe(scroller);
  });

  it("reserves blank space above and below the rows and styles the row column", async () => {
    const { container } = render(
      <List items={msgs(3)} paddingTop={8} paddingBottom={64} contentClassName="mx-auto max-w-3xl" className="flex-1" />,
    );
    await settled();
    const scroller = container.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement;
    expect(scroller.className).toContain("flex-1");
    const list = container.querySelector('[data-testid="virtuoso-item-list"]') as HTMLElement;
    expect(list.className).toContain("max-w-3xl");
    const spacers = [...container.querySelectorAll<HTMLElement>("[data-virtuoso-scroller] div")]
      .filter((el) => el.style.height === "8px" || el.style.height === "64px")
      .map((el) => el.style.height);
    expect(spacers).toEqual(["8px", "64px"]);
    // The top spacer comes before the rows, the bottom one after.
    const top = container.querySelector<HTMLElement>('[data-virtuoso-scroller] div[style*="height: 8px"]')!;
    expect(top.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("starts a new list when the conversation changes", async () => {
    const { container, rerender } = render(<List items={[...msgs(2, 98), ...msgs(3, 100)]} listKey="a" />);
    await settled();
    rerender(<List items={msgs(3, 100)} listKey="b" />);
    await settled();
    // A fresh list counts from the base again instead of treating it as a removal.
    expect(virtualIndexes(container)[0]).toBe(FIRST_ITEM_BASE);
  });

  it("a throwing row shows its inline fallback and leaves its neighbours mounted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Bubble({ m }: { m: Msg }) {
      if (m.id === "m2") throw new Error("bubble exploded");
      return <div data-testid="msg">{m.id}</div>;
    }
    render(
      <List
        items={msgs(5)}
        renderItem={(m) => (
          <ItemBoundary id={m.id} label="test-msg" noun="message">
            <Bubble m={m} />
          </ItemBoundary>
        )}
      />,
    );
    await settled();
    expect(screen.getAllByTestId("msg").map((el) => el.textContent)).toEqual(["m0", "m1", "m3", "m4"]);
    const fallbacks = screen.getAllByRole("status");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toHaveTextContent("This message couldn't be displayed.");
  });

  it("renders nothing for an empty conversation and picks up the first message", async () => {
    const { rerender } = render(<List items={[]} />);
    expect(screen.queryByTestId("msg")).toBeNull();
    rerender(<List items={msgs(1)} />);
    expect(await screen.findByText("m0")).toBeInTheDocument();
  });
});

/**
 * React may render a component and then not commit that render: Strict Mode
 * renders everything twice, and a render inside a transition is thrown away
 * when something in it suspends, then done again later. What the list decides
 * about a change (follow it, report it as missed, hold the rows through a
 * prepend) has to come out the same however many times it was rendered.
 */
describe("VirtualMessageList under replayed and discarded renders", () => {
  it("Strict Mode: a message appended while pinned to the bottom is followed, once", async () => {
    const shouldFollow = vi.fn(({ atBottom }: { atBottom: boolean }) => atBottom);
    const onMissedAppend = vi.fn();
    const handle = createRef<VirtualMessageListHandle>();
    const first = msgs(200);
    const props = { shouldFollow, onMissedAppend, handleRef: handle };
    const { container, rerender } = render(
      <StrictMode>
        <List items={first} {...props} />
      </StrictMode>,
    );
    await settled();
    scrollTo(container, { scrollTop: 9400, scrollHeight: 10_000, clientHeight: 600 }); // at the end

    rerender(
      <StrictMode>
        <List items={[...first, { id: "new" }]} {...props} />
      </StrictMode>,
    );
    expect(shouldFollow).toHaveBeenCalledTimes(1);
    expect(shouldFollow.mock.calls[0][0]).toMatchObject({ atBottom: true, last: { id: "new" } });
    expect(onMissedAppend).not.toHaveBeenCalled();
    expect(handle.current!.isAtBottom()).toBe(true);
    expect(await screen.findByText("new")).toBeInTheDocument();
  });

  it("Strict Mode: a message appended while up in history is reported as missed, once", async () => {
    const onMissedAppend = vi.fn();
    const handle = createRef<VirtualMessageListHandle>();
    const first = msgs(200);
    const props = { onMissedAppend, handleRef: handle };
    const { container, rerender } = render(
      <StrictMode>
        <List items={first} {...props} />
      </StrictMode>,
    );
    await settled();
    scrollTo(container, { scrollTop: 9400, scrollHeight: 10_000, clientHeight: 600 });
    scrollTo(container, { scrollTop: 1000, scrollHeight: 10_000, clientHeight: 600 });
    rerender(
      <StrictMode>
        <List items={[...first, { id: "new" }]} {...props} />
      </StrictMode>,
    );
    expect(onMissedAppend).toHaveBeenCalledTimes(1);
    expect(handle.current!.isAtBottom()).toBe(false);
  });

  it("Strict Mode: history arriving above shifts the index by exactly the rows added", async () => {
    const first = msgs(3, 100);
    const { container, rerender } = render(
      <StrictMode>
        <List items={first} />
      </StrictMode>,
    );
    await settled();
    expect(virtualIndexes(container)).toEqual([FIRST_ITEM_BASE, FIRST_ITEM_BASE + 1, FIRST_ITEM_BASE + 2]);
    rerender(
      <StrictMode>
        <List items={[...msgs(2, 98), ...first]} />
      </StrictMode>,
    );
    expect(virtualIndexOf("m100")).toBe(FIRST_ITEM_BASE);
    expect(virtualIndexOf("m102")).toBe(FIRST_ITEM_BASE + 2);
    await waitFor(() => expect(virtualIndexOf("m98")).toBe(FIRST_ITEM_BASE - 2));
    // And again: each prepend is counted once.
    rerender(
      <StrictMode>
        <List items={[...msgs(3, 95), ...msgs(2, 98), ...first]} />
      </StrictMode>,
    );
    expect(virtualIndexOf("m100")).toBe(FIRST_ITEM_BASE);
    await waitFor(() => expect(virtualIndexOf("m97")).toBe(FIRST_ITEM_BASE - 3));
  });

  /**
   * Renders the list next to a component that can suspend. Changing both in
   * one transition makes React render the list with the new rows, throw that
   * render away when the neighbour suspends, and render it again once the
   * neighbour is ready.
   */
  function suspendingHarness(initial: Msg[], props: Omit<Partial<VirtualMessageListProps<Msg>>, "items">) {
    const api = { set: (_items: Msg[], _wait: Promise<void> | null) => {}, renders: [] as number[] };
    function Neighbour({ wait }: { wait: Promise<void> | null }) {
      if (wait) use(wait);
      return null;
    }
    function Harness() {
      const [state, setState] = useState<{ items: Msg[]; wait: Promise<void> | null }>({ items: initial, wait: null });
      api.set = (items, wait) => startTransition(() => setState({ items, wait }));
      api.renders.push(state.items.length);
      return (
        <Suspense fallback={null}>
          <List items={state.items} {...props} />
          <Neighbour wait={state.wait} />
        </Suspense>
      );
    }
    return { api, Harness };
  }

  it("a render that was thrown away does not use up the decision to follow", async () => {
    const handle = createRef<VirtualMessageListHandle>();
    const onMissedAppend = vi.fn();
    const first = msgs(200);
    // An own send is followed from anywhere.
    const follow = ({ last }: { last: Msg }) => last.id.startsWith("temp");
    const { api, Harness } = suspendingHarness(first, { shouldFollow: follow, onMissedAppend, handleRef: handle });
    const { container } = render(<Harness />);
    await settled();
    scrollTo(container, { scrollTop: 9400, scrollHeight: 10_000, clientHeight: 600 });
    scrollTo(container, { scrollTop: 1000, scrollHeight: 10_000, clientHeight: 600 });
    expect(handle.current!.isAtBottom()).toBe(false);

    let ready!: () => void;
    const wait = new Promise<void>((resolve) => (ready = resolve));
    await act(async () => api.set([...first, { id: "temp-1" }], wait));
    // Rendered with the new row, but nothing was committed.
    expect(api.renders).toContain(201);
    expect(handle.current!.isAtBottom()).toBe(false);

    await act(async () => {
      ready();
      await wait;
    });
    // Committed now: the send is followed.
    expect(handle.current!.isAtBottom()).toBe(true);
    expect(onMissedAppend).not.toHaveBeenCalled();
  });

  it("a render that was thrown away does not lose the report of a missed message", async () => {
    const onMissedAppend = vi.fn();
    const first = msgs(200);
    const { api, Harness } = suspendingHarness(first, { onMissedAppend });
    const { container } = render(<Harness />);
    await settled();
    scrollTo(container, { scrollTop: 9400, scrollHeight: 10_000, clientHeight: 600 });
    scrollTo(container, { scrollTop: 1000, scrollHeight: 10_000, clientHeight: 600 });

    let ready!: () => void;
    const wait = new Promise<void>((resolve) => (ready = resolve));
    await act(async () => api.set([...first, { id: "new" }], wait));
    expect(onMissedAppend).not.toHaveBeenCalled();
    await act(async () => {
      ready();
      await wait;
    });
    expect(onMissedAppend).toHaveBeenCalledTimes(1);
  });

  it("a render that was thrown away and never done again leaves nothing behind", async () => {
    const onMissedAppend = vi.fn();
    const first = msgs(200);
    const { api, Harness } = suspendingHarness(first, { onMissedAppend });
    const { container } = render(<Harness />);
    await settled();
    scrollTo(container, { scrollTop: 9400, scrollHeight: 10_000, clientHeight: 600 });
    scrollTo(container, { scrollTop: 1000, scrollHeight: 10_000, clientHeight: 600 });

    // A message is rendered, the render is thrown away, and the message is
    // gone again (deleted) before anything was committed.
    await act(async () => api.set([...first, { id: "new" }], new Promise<void>(() => {})));
    await act(async () => api.set(first, null));
    expect(onMissedAppend).not.toHaveBeenCalled();
    // The next real message is still reported, exactly once.
    await act(async () => api.set([...first, { id: "later" }], null));
    expect(onMissedAppend).toHaveBeenCalledTimes(1);
  });
});
