/**
 * The AI conversation list is virtualized. Regression cover for following the
 * stream: it stays on the newest content while the reader is at the bottom,
 * lets go the moment they scroll up, and re-attaches when they come back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { createTestStore, type TestStore } from "@/__tests__/helpers/createTestStore";
import {
  VirtualViewport,
  captureResizeObservers,
  virtualListContent,
  virtualListSettled,
} from "@/__tests__/helpers/virtualList";

const fixture = vi.hoisted(() => ({ explodeId: null as string | null }));

vi.mock("../AIMessageBubble", () => ({
  AIMessageBubble: ({ messageId, isLast }: { messageId: string; isLast: boolean }) => {
    if (messageId === fixture.explodeId) throw new Error("ai bubble exploded");
    return (
      <div data-testid="ai-row" data-last={isLast ? "yes" : "no"}>
        {messageId}
      </div>
    );
  },
}));
vi.mock("../gate/PendingWriteCard", () => ({
  PendingWriteCard: ({ id }: { id: string }) => <div data-testid="write-row">{id}</div>,
}));

import { AIMessageList } from "../AIMessageList";

const CONV = "conv-1";

function makeStore(messageCount: number, opts: { streaming?: boolean; writes?: string[]; conv?: string } = {}): TestStore {
  const base = createTestStore().getState();
  const conv = opts.conv ?? CONV;
  return createTestStore({
    ...base,
    ai: {
      ...base.ai,
      messagesByConversation: { [conv]: Array.from({ length: messageCount }, (_, i) => `ai-${i}`) },
      streamingByConversation: opts.streaming ? { [conv]: true } : {},
      pendingWriteIdsByConversation: opts.writes ? { [conv]: opts.writes } : {},
    } as unknown as typeof base.ai,
  });
}

let resizes: ReturnType<typeof captureResizeObservers>;

function renderList(store: TestStore, conversationId = CONV) {
  return renderWithProviders(
    <VirtualViewport height={600} rowHeight={100}>
      <AIMessageList conversationId={conversationId} />
    </VirtualViewport>,
    { store },
  );
}

const scrollerOf = (container: HTMLElement) =>
  container.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement;

/** Give the scroller real-looking geometry; `scrollTop` stays writable. */
function setGeometry(scroller: HTMLElement, g: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(scroller, "scrollHeight", { value: g.scrollHeight, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: g.clientHeight, configurable: true });
  scroller.scrollTop = g.scrollTop;
}

/** The content grew (a streamed chunk arrived): new height, then notify. */
function grow(scroller: HTMLElement, scrollHeight: number) {
  Object.defineProperty(scroller, "scrollHeight", { value: scrollHeight, configurable: true });
  act(() => resizes.fire(virtualListContent(scroller)));
}

/** A scroll the user made: wheel input, then the scroll. */
function userScroll(scroller: HTMLElement, scrollTop: number) {
  scroller.scrollTop = scrollTop;
  act(() => {
    scroller.dispatchEvent(new Event("wheel"));
    scroller.dispatchEvent(new Event("scroll"));
  });
}

/** A scroll the virtualizer made itself (through the element's `scrollTo`). */
async function listScroll(scroller: HTMLElement, scrollTop: number) {
  await act(async () => {
    scroller.scrollTo({ top: scrollTop });
    await Promise.resolve();
  });
}

/** Let the list's "we are scrolling" guard clear (one animation frame). */
const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

beforeEach(() => {
  fixture.explodeId = null;
  resizes = captureResizeObservers();
});

afterEach(() => {
  resizes.restore();
  vi.restoreAllMocks();
});

describe("AIMessageList (virtualized)", () => {
  it("mounts a window of a 2000-message conversation and opens on the newest message", async () => {
    renderList(makeStore(2000));
    await virtualListSettled();
    expect(screen.getAllByTestId("ai-row").length).toBeLessThan(60);
    expect(screen.getByText("ai-1999")).toBeInTheDocument();
    expect(screen.queryByText("ai-0")).toBeNull();
  });

  it("marks only the newest message as last, and lists pending writes after the messages", async () => {
    const { container } = renderList(makeStore(3, { writes: ["write-1"] }));
    await virtualListSettled();
    expect(screen.getAllByTestId("ai-row").map((el) => el.dataset.last)).toEqual(["no", "no", "yes"]);
    const write = screen.getByTestId("write-row");
    expect(screen.getByText("ai-2").compareDocumentPosition(write) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll("[data-item-index]")).toHaveLength(4);
  });

  it("follows the reply as it grows while the reader is at the bottom", async () => {
    const { container } = renderList(makeStore(20, { streaming: true }));
    await virtualListSettled();
    const scroller = scrollerOf(container);
    setGeometry(scroller, { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 });

    grow(scroller, 2300);
    expect(scroller.scrollTop).toBe(2300); // pinned to the new end
    grow(scroller, 2900);
    expect(scroller.scrollTop).toBe(2900);
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).toBeNull();
  });

  it("stops following the moment the reader scrolls up, and offers the jump button", async () => {
    const { container } = renderList(makeStore(20, { streaming: true }));
    await virtualListSettled();
    const scroller = scrollerOf(container);
    setGeometry(scroller, { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 });
    grow(scroller, 2300);
    await nextFrame();

    userScroll(scroller, 1500); // pulled up from 2300
    expect(screen.getByRole("button", { name: "Scroll to latest" })).toBeInTheDocument();

    grow(scroller, 3000); // the reply keeps streaming
    expect(scroller.scrollTop).toBe(1500); // the reader is left where they are
  });

  it("keeps following when the list corrects its own position upwards", async () => {
    const { container } = renderList(makeStore(20, { streaming: true }));
    await virtualListSettled();
    const scroller = scrollerOf(container);
    setGeometry(scroller, { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 });
    grow(scroller, 2300);
    await nextFrame();

    await listScroll(scroller, 1500); // not the reader: the virtualizer's own scroll
    grow(scroller, 3000);
    expect(scroller.scrollTop).toBe(3000); // still attached
  });

  it("re-attaches when the reader scrolls back to the bottom", async () => {
    const { container } = renderList(makeStore(20, { streaming: true }));
    await virtualListSettled();
    const scroller = scrollerOf(container);
    setGeometry(scroller, { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 });
    grow(scroller, 2000); // following: pinned at the end
    await nextFrame();
    userScroll(scroller, 900); // up
    grow(scroller, 2400);
    expect(scroller.scrollTop).toBe(900);

    userScroll(scroller, 1790); // back within 64px of the end (2400 - 600 = 1800)
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).toBeNull();
    grow(scroller, 2800);
    expect(scroller.scrollTop).toBe(2800);
  });

  it("the jump button goes to the end and re-attaches", async () => {
    const { container } = renderList(makeStore(20, { streaming: true }));
    await virtualListSettled();
    const scroller = scrollerOf(container);
    setGeometry(scroller, { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 });
    grow(scroller, 2000); // following: pinned at the end
    await nextFrame();
    userScroll(scroller, 300);

    fireEvent.click(screen.getByRole("button", { name: "Scroll to latest" }));
    expect(scroller.scrollTop).toBe(2000);
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).toBeNull();
    grow(scroller, 2600);
    expect(scroller.scrollTop).toBe(2600);
  });

  it("does not mistake its own scrolling for the reader taking over", async () => {
    const { container } = renderList(makeStore(20, { streaming: true }));
    await virtualListSettled();
    const scroller = scrollerOf(container);
    setGeometry(scroller, { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 });
    grow(scroller, 2300);
    // The scroll event caused by the pin itself arrives in the same frame.
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    grow(scroller, 2700);
    expect(scroller.scrollTop).toBe(2700);
  });

  it("announces generating and completion to screen readers, never per token", async () => {
    const streaming = renderList(makeStore(3, { streaming: true }));
    expect(screen.getByRole("status")).toHaveTextContent("Generating response…");
    streaming.unmount();
    renderList(makeStore(3));
    expect(screen.getByRole("status")).toHaveTextContent("Response complete");
  });

  it("a throwing message shows its inline fallback and leaves its neighbours mounted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.explodeId = "ai-1";
    renderList(makeStore(4));
    await virtualListSettled();
    expect(screen.getAllByTestId("ai-row").map((el) => el.textContent)).toEqual(["ai-0", "ai-2", "ai-3"]);
    expect(screen.getByText("This message couldn't be displayed.")).toBeInTheDocument();
  });
});
