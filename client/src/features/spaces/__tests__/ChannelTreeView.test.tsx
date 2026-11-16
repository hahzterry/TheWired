/**
 * The channel tree: members get the plain list with no drag-and-drop code at
 * all; people who can arrange channels get the dnd tree as a lazy chunk, with
 * the plain list standing in while it loads and if it cannot be loaded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { resetCrashLogForTests } from "@/lib/crash/crashLog";
import { retryFailedLazyImports, setLazyImportsFailingForTests } from "@/lib/lazyWithRetry";
import type { SpaceChannel } from "@/types/space";
import type { ChannelTree } from "../channelTree";
import type { ChannelTreeDndProps } from "../ChannelTreeView";

const dnd = vi.hoisted(() => ({ loads: 0 }));

vi.mock("../ChannelTreeDnd", () => {
  dnd.loads += 1;
  return {
    ChannelTreeDnd: ({ tree, renderChannel }: ChannelTreeDndProps) => (
      <div data-testid="dnd-tree">
        {tree.uncategorized.map((ch) => (
          <div key={ch.id}>{renderChannel(ch, { dragging: false, handle: undefined })}</div>
        ))}
      </div>
    ),
  };
});

import { ChannelTreeView, PlainChannelTree } from "../ChannelTreeView";

const ch = (id: string, categoryId: string | null = null): SpaceChannel =>
  ({
    id,
    spaceId: "s",
    type: "chat",
    label: id,
    categoryId,
    position: 0,
    isDefault: false,
    adminOnly: false,
    slowModeSeconds: 0,
  }) as SpaceChannel;

const TREE: ChannelTree = {
  uncategorized: [ch("general"), ch("random")],
  categories: [
    { category: { id: "c1", name: "Projects", position: 0 }, channels: [ch("alpha", "c1")] },
    { category: { id: "c2", name: "Empty", position: 1 }, channels: [] },
  ],
} as unknown as ChannelTree;

function props(overrides: Partial<ChannelTreeDndProps> = {}): ChannelTreeDndProps {
  return {
    tree: TREE,
    enabled: false,
    onMoveChannel: vi.fn(),
    onMoveCategory: vi.fn(),
    renderChannel: (channel) => <span data-testid={`row-${channel.id}`}>#{channel.label}</span>,
    renderCategoryHeader: (node) => <span data-testid={`cat-${node.category.id}`}>{node.category.name}</span>,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetCrashLogForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setLazyImportsFailingForTests(false);
  vi.restoreAllMocks();
});

describe("ChannelTreeView", () => {
  it("renders the plain list for members and never loads the drag-and-drop chunk", async () => {
    render(<ChannelTreeView {...props({ enabled: false })} />);

    for (const id of ["general", "random", "alpha"]) {
      expect(screen.getByTestId(`row-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("cat-c1")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(dnd.loads).toBe(0);
    expect(screen.queryByTestId("dnd-tree")).toBeNull();
  });

  it("PlainChannelTree honours collapsed subfolders and the category filter", () => {
    render(
      <PlainChannelTree
        {...props({
          collapsed: new Set(["c1"]),
          showCategory: (node) => node.channels.length > 0,
        })}
      />,
    );
    expect(screen.getByTestId("cat-c1")).toBeInTheDocument();
    expect(screen.queryByTestId("row-alpha")).toBeNull();
    expect(screen.queryByTestId("cat-c2")).toBeNull();
  });

  // Failure before the first successful load: the lazy component is a singleton.
  it("if the drag-and-drop chunk cannot be loaded, arrangers keep the plain list instead of an error", async () => {
    setLazyImportsFailingForTests(true);
    render(<ChannelTreeView {...props({ enabled: true })} />);

    // Same rows while loading...
    expect(screen.getByTestId("row-general")).toBeInTheDocument();
    // ...and still the same rows once the load has failed: no alert in the sidebar.
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    for (const id of ["general", "random", "alpha"]) {
      expect(screen.getByTestId(`row-${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("dnd-tree")).toBeNull();
  });

  it("for arrangers the plain list stands in until the drag-and-drop tree has loaded", async () => {
    // The failed import above is re-armed the way the app does it: an error
    // boundary resetting (on navigation, or Retry) calls this.
    expect(retryFailedLazyImports()).toBe(1);
    render(<ChannelTreeView {...props({ enabled: true })} />);

    // First paint: every row is already there, from the plain list.
    expect(screen.queryByTestId("dnd-tree")).toBeNull();
    expect(screen.getByTestId("row-general")).toBeInTheDocument();
    expect(screen.getByTestId("row-alpha")).toBeInTheDocument();

    expect(await screen.findByTestId("dnd-tree")).toBeInTheDocument();
    expect(screen.getByTestId("row-general")).toBeInTheDocument();
    expect(dnd.loads).toBe(1);
  });
});
