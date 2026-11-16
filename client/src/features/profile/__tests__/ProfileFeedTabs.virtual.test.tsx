/**
 * The profile feed tabs are virtualized inside the profile page's scroller.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import type { NostrEvent } from "@/types/nostr";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { VirtualViewport } from "@/__tests__/helpers/virtualList";
import type { ProfileFeedItem } from "../useProfileNotes";

const fixture = vi.hoisted(() => ({
  reported: [] as { ids: string[]; startIndex: number; key: string }[],
  explodeId: null as string | null,
  cards: [] as { id: string; index: number; animate: boolean; anchorId?: string }[],
}));

vi.mock("../engagementCollector", () => ({
  useEngagementRange: (_relays: unknown, key: string) => (ids: readonly string[], startIndex: number) => {
    fixture.reported.push({ ids: [...ids], startIndex, key });
  },
  EngagementCollectorProvider: ({ children }: { children: React.ReactNode }) => children,
  useEngagementReporter: () => ({ current: null }),
}));
vi.mock("../NoteCard", () => ({
  ProfileNoteCard: ({
    item,
    index,
    animate,
    anchorId,
  }: {
    item: ProfileFeedItem;
    index: number;
    animate?: boolean;
    anchorId?: string;
  }) => {
    if (item.event.id === fixture.explodeId) throw new Error("profile card exploded");
    fixture.cards.push({ id: item.event.id, index, animate: !!animate, anchorId });
    return (
      <div data-testid="profile-card" data-feed-anchor={anchorId}>
        {item.event.content}
      </div>
    );
  },
  PinnedNotesSection: () => null,
}));
vi.mock("@/features/longform/ArticleCard", () => ({
  ArticleCard: ({ article, onClick }: { article: { title: string }; onClick: () => void }) => (
    <button data-testid="article-card" onClick={onClick}>
      {article.title}
    </button>
  ),
}));

import { FeedTab, ReadsTab, type FeedVirtualProps } from "../ProfilePage";

function feedItems(count: number): ProfileFeedItem[] {
  return Array.from({ length: count }, (_, i) => {
    const event: NostrEvent = {
      id: `p-${i}`,
      pubkey: "ef".repeat(32),
      created_at: 1_700_000_000 - i,
      kind: 1,
      tags: [],
      content: `profile note ${i}`,
      sig: "",
    };
    return { event, repostedEventId: null, reposterPubkey: null };
  });
}

/** The tab inside its page scroller, like ProfilePage mounts it. */
function Tab(props: Partial<Parameters<typeof FeedTab>[0]> & { items: ProfileFeedItem[] }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const virtual: FeedVirtualProps = {
    scrollParent: scroller,
    feedRef: { current: null },
    listKey: "pubkey:notes",
    initialAnchor: null,
  };
  return (
    <VirtualViewport height={900} rowHeight={240}>
      <div ref={setScroller}>
        <FeedTab
          loading={false}
          eoseReceived
          emptyIcon={<span />}
          emptyText="No notes yet"
          label="notes"
          virtual={virtual}
          {...props}
        />
      </div>
    </VirtualViewport>
  );
}

beforeEach(() => {
  fixture.reported.length = 0;
  fixture.cards.length = 0;
  fixture.explodeId = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("profile FeedTab (virtualized)", () => {
  it("mounts a window of a 2000-note feed, not all of it", () => {
    renderWithProviders(<Tab items={feedItems(2000)} />);
    const cards = screen.getAllByTestId("profile-card");
    expect(cards.length).toBeGreaterThan(2);
    expect(cards.length).toBeLessThan(40);
    expect(screen.getByText("profile note 0")).toBeInTheDocument();
    expect(screen.queryByText("profile note 1999")).toBeNull();
  });

  it("gives each card its feed index and its scroll-restore anchor", () => {
    renderWithProviders(<Tab items={feedItems(4)} />);
    const anchors = screen.getAllByTestId("profile-card").map((el) => el.getAttribute("data-feed-anchor"));
    expect(anchors).toEqual(["p-0", "p-1", "p-2", "p-3"]);
    const first = fixture.cards.find((c) => c.id === "p-2")!;
    expect(first.index).toBe(2);
  });

  it("animates the first cards on the first paint only", () => {
    renderWithProviders(<Tab items={feedItems(30)} />);
    const byId = new Map(fixture.cards.map((c) => [c.id, c]));
    expect(byId.get("p-0")!.animate).toBe(true);
  });

  it("requests engagement for the rendered range, keyed by the list", () => {
    renderWithProviders(<Tab items={feedItems(2000)} />);
    const last = fixture.reported[fixture.reported.length - 1];
    expect(last.key).toBe("pubkey:notes");
    expect(last.startIndex).toBe(0);
    expect(last.ids[0]).toBe("p-0");
    expect(last.ids.length).toBeLessThan(40);
  });

  it("reveals the next local page while the end of the list is rendered", () => {
    const onLoadMore = vi.fn();
    renderWithProviders(<Tab items={feedItems(3)} hasMore onLoadMore={onLoadMore} />);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("does not reveal more when the end is far away, or nothing more is held", () => {
    const onLoadMore = vi.fn();
    const far = renderWithProviders(<Tab items={feedItems(2000)} hasMore onLoadMore={onLoadMore} />);
    expect(onLoadMore).not.toHaveBeenCalled();
    far.unmount();
    renderWithProviders(<Tab items={feedItems(3)} hasMore={false} onLoadMore={onLoadMore} />);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("keeps the older-notes button and its busy state under the list", () => {
    const onFetchOlder = vi.fn();
    const idle = renderWithProviders(<Tab items={feedItems(3)} hasMore={false} onFetchOlder={onFetchOlder} />);
    fireEvent.click(screen.getByRole("button", { name: "Load older notes" }));
    expect(onFetchOlder).toHaveBeenCalledTimes(1);
    idle.unmount();

    renderWithProviders(<Tab items={feedItems(3)} hasMore={false} onFetchOlder={onFetchOlder} fetchingMore />);
    expect(screen.getByText("Loading older notes...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load older notes" })).toBeDisabled();
  });

  it("shows the spinner while loading and the empty state when there is nothing", () => {
    const loading = renderWithProviders(<Tab items={[]} loading eoseReceived={false} />);
    expect(screen.queryByText("No notes yet")).toBeNull();
    loading.unmount();
    renderWithProviders(<Tab items={[]} />);
    expect(screen.getByText("No notes yet")).toBeInTheDocument();
  });

  it("a throwing card shows its inline fallback and leaves its neighbours mounted", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.explodeId = "p-1";
    renderWithProviders(<Tab items={feedItems(4)} />);
    expect(screen.getByText("profile note 0")).toBeInTheDocument();
    expect(screen.getByText("profile note 2")).toBeInTheDocument();
    expect(screen.queryByText("profile note 1")).toBeNull();
    expect(screen.getByText("This note couldn't be displayed.")).toBeInTheDocument();
  });
});

describe("profile ReadsTab (virtualized)", () => {
  function Reads({ count, hasMore, onLoadMore }: { count: number; hasMore?: boolean; onLoadMore?: () => void }) {
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
    const articles = Array.from({ length: count }, (_, i) => ({ eventId: `a-${i}`, title: `article ${i}` }));
    return (
      <VirtualViewport height={900} rowHeight={150}>
        <div ref={setScroller}>
          <ReadsTab
            articles={articles as never}
            loading={false}
            hasMore={hasMore}
            onLoadMore={onLoadMore}
            virtual={{ scrollParent: scroller, feedRef: { current: null }, listKey: "pubkey:reads", initialAnchor: null }}
          />
        </div>
      </VirtualViewport>
    );
  }

  it("mounts a window of a long article list and anchors each card", () => {
    const { container } = renderWithProviders(<Reads count={1500} />);
    const cards = screen.getAllByTestId("article-card");
    expect(cards.length).toBeLessThan(40);
    expect(container.querySelector('[data-feed-anchor="a-0"]')).not.toBeNull();
    expect(screen.queryByText("article 1499")).toBeNull();
  });

  it("reveals the next page while the end is rendered", () => {
    const onLoadMore = vi.fn();
    renderWithProviders(<Reads count={3} hasMore onLoadMore={onLoadMore} />);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state with no articles", () => {
    renderWithProviders(<Reads count={0} />);
    expect(screen.getByText("No articles yet")).toBeInTheDocument();
  });
});
