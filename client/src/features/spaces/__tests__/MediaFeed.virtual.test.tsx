/**
 * The media grid is virtualized row by row: tiles are cut into rows of the
 * current column count and only the rows around the viewport are mounted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import type { NostrEvent } from "@/types/nostr";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";

const fixture = vi.hoisted(() => {
  const picture = (n: number): NostrEvent => ({
    id: `pic-${n}`,
    pubkey: "cd".repeat(32),
    created_at: 1_700_000_000 - n,
    kind: 20,
    tags: [["url", `https://media.example/img-${n}.png`]],
    content: "",
    sig: "",
  });
  const state = {
    events: [] as NostrEvent[],
    meta: { isRefreshing: false, isLoadingMore: false, hasMore: true, loadMoreError: null as string | null },
    loadMore: vi.fn(),
    explodeUrl: null as string | null,
    setCount(count: number) {
      state.events = Array.from({ length: count }, (_, i) => picture(i));
    },
  };
  return state;
});

vi.mock("../spaceSelectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../spaceSelectors")>()),
  selectSpaceMediaEvents: () => fixture.events,
}));
vi.mock("../useFeedPagination", () => ({
  useFeedPagination: () => ({ meta: fixture.meta, refresh: () => {}, loadMore: fixture.loadMore }),
}));
vi.mock("../FeedToolbar", () => ({ FeedToolbar: () => null }));
vi.mock("@/hooks/usePlaybackBarSpacing", () => ({
  usePlaybackBarSpacing: () => ({ scrollPaddingClass: "" }),
}));
vi.mock("@/features/profile/useProfile", () => ({
  useProfile: (pubkey: string) => {
    if (fixture.explodeUrl) throw new Error(`tile exploded for ${pubkey.slice(0, 4)}`);
    return { profile: null };
  },
}));
vi.mock("@/features/wallet/WalletProvider", () => ({ useZap: () => ({ openZap: () => {} }) }));
vi.mock("@/lib/media/mediaGrant", () => ({ useMediaGrant: () => 0 }));
vi.mock("@/lib/media/eventMedia", () => ({ tokenizeEventMediaUrl: (url: string) => url }));
vi.mock("@/components/content/RichContent", () => ({ RichContent: () => null }));
vi.mock("@/features/media/EnhancedVideoPlayer", () => ({ EnhancedVideoPlayer: () => null }));
// The real height memory, with the lookups a grid makes when it opens recorded.
vi.mock("@/lib/virtual/itemHeights", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/virtual/itemHeights")>();
  return { ...actual, initialHeightEstimates: vi.fn(actual.initialHeightEstimates) };
});

import { MediaFeed, rowIndexOfTile } from "../MediaFeed";
import { initialHeightEstimates, resetItemHeightsForTests } from "@/lib/virtual/itemHeights";

function renderFeed(channelId = "space-1:media") {
  return renderWithProviders(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 300 }}>
      <MediaFeed />
    </VirtuosoMockContext.Provider>,
    {
      preloadedState: {
        spaces: { list: [], activeSpaceId: "space-1", activeChannelId: channelId },
      } as never,
    },
  );
}

/** Make the CSS breakpoints report a width: 2, 3 or 4 columns. */
function stubColumns(columns: 2 | 3 | 4) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 64rem)" ? columns >= 4 : query === "(min-width: 40rem)" ? columns >= 3 : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  fixture.setCount(0);
  fixture.meta = { isRefreshing: false, isLoadingMore: false, hasMore: true, loadMoreError: null };
  fixture.loadMore.mockReset();
  fixture.explodeUrl = null;
  resetItemHeightsForTests();
  vi.mocked(initialHeightEstimates).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MediaFeed (virtualized grid)", () => {
  it("mounts a window of a 2000-tile grid, not all of it", () => {
    stubColumns(4);
    fixture.setCount(2000);
    const { container } = renderFeed();
    const tiles = container.querySelectorAll("img");
    expect(tiles.length).toBeGreaterThan(8);
    expect(tiles.length).toBeLessThan(80);
    expect(container.querySelector('img[src="https://media.example/img-0.png"]')).not.toBeNull();
    expect(container.querySelector('img[src="https://media.example/img-1999.png"]')).toBeNull();
  });

  it.each([2, 3, 4] as const)("lays tiles out in rows of %i at that width", (columns) => {
    stubColumns(columns);
    fixture.setCount(10);
    const { container } = renderFeed();
    const rows = [...container.querySelectorAll("[data-feed-anchor]")];
    expect(rows).toHaveLength(Math.ceil(10 / columns));
    expect(rows[0].querySelectorAll("img")).toHaveLength(columns);
    // Every row keeps the responsive grid classes, so CSS draws it as one line.
    expect(rows[0].className).toContain("grid-cols-2");
    expect(rows[0].className).toContain("sm:grid-cols-3");
    expect(rows[0].className).toContain("lg:grid-cols-4");
    // The row is anchored by its first tile, for scroll restoration.
    expect(rows[1].getAttribute("data-feed-anchor")).toBe(`pic-${columns}:img`);
  });

  it("starts another channel's grid without the row heights this one measured", async () => {
    stubColumns(4);
    fixture.setCount(40);
    const lookups = vi.mocked(initialHeightEstimates);
    const remembered = () => lookups.mock.results[lookups.mock.results.length - 1]?.value as number[] | undefined;

    // The grid's rows are keyed by position, so "row-0" exists in every grid.
    const first = renderFeed("space-1:media");
    expect(remembered()).toBeUndefined();
    // Once its rows are measured they are remembered: reopening finds them.
    await waitFor(() => {
      first.unmount();
      const again = renderFeed("space-1:media");
      try {
        expect(remembered()).toBeDefined();
      } finally {
        again.unmount();
      }
    });

    // Same width, same column count, another channel: nothing to go on.
    renderFeed("space-1:other-media");
    expect(remembered()).toBeUndefined();
  });

  it("opens the expanded view when a tile is clicked", () => {
    stubColumns(3);
    fixture.setCount(6);
    const { container } = renderFeed();
    fireEvent.click(container.querySelector('img[src="https://media.example/img-2.png"]')!.closest("button")!);
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    // The grid stays mounted under the overlay.
    expect(container.querySelector('img[src="https://media.example/img-0.png"]')).not.toBeNull();
  });

  it("keeps the load-more error and retry under the grid", () => {
    stubColumns(3);
    fixture.setCount(6);
    fixture.meta = { ...fixture.meta, loadMoreError: "timeout" };
    renderFeed();
    expect(screen.getByRole("alert")).toHaveTextContent("The relays took too long to answer.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(fixture.loadMore).toHaveBeenCalledTimes(1);
  });

  it("a throwing tile shows its fallback in place; the row and feed stay", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubColumns(3);
    fixture.setCount(6);
    fixture.explodeUrl = "all";
    const { container } = renderFeed();
    // Every tile's footer throws here; each is contained on its own.
    expect(screen.getAllByRole("status")).toHaveLength(6);
    expect(container.querySelectorAll("[data-feed-anchor]")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
  });

  it("shows the empty state with no media", () => {
    renderFeed();
    expect(screen.getByText("No media yet from space members")).toBeInTheDocument();
  });
});

describe("rowIndexOfTile", () => {
  const rows = [
    { items: [{ key: "a" }, { key: "b" }] },
    { items: [{ key: "c" }, { key: "d" }] },
    { items: [{ key: "e" }] },
  ];

  it("finds the row holding a tile, wherever it sits in the row", () => {
    expect(rowIndexOfTile(rows, "a")).toBe(0);
    expect(rowIndexOfTile(rows, "d")).toBe(1);
    expect(rowIndexOfTile(rows, "e")).toBe(2);
  });

  it("is -1 for a tile that is not in the grid", () => {
    expect(rowIndexOfTile(rows, "zzz")).toBe(-1);
  });
});
