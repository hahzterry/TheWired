/**
 * The notes feed is virtualized: a long feed mounts only the cards around the
 * viewport, engagement is requested for the rendered range, and the relay
 * "load more" control keeps its error and retry state below the list.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import type { NostrEvent } from "@/types/nostr";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";

const fixture = vi.hoisted(() => {
  const note = (n: number): NostrEvent => ({
    id: `note-${n}`,
    pubkey: "ab".repeat(32),
    created_at: 1_700_000_000 - n,
    kind: 1,
    tags: [],
    content: `body of note ${n}`,
    sig: "",
  });
  const state = {
    notes: [] as NostrEvent[],
    ids: [] as string[],
    meta: { isRefreshing: false, isLoadingMore: false, hasMore: true, loadMoreError: null as string | null },
    loadMore: vi.fn(),
    reported: [] as { ids: string[]; startIndex: number }[],
    setNotes(count: number) {
      state.notes = Array.from({ length: count }, (_, i) => note(i));
      state.ids = state.notes.map((n) => n.id);
    },
  };
  return state;
});

vi.mock("../spaceSelectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../spaceSelectors")>()),
  selectSpaceRootNotes: () => fixture.notes,
  selectSpaceRootNoteIds: () => fixture.ids,
  selectActiveSpace: () => null,
}));
vi.mock("../useFeedPagination", () => ({
  useFeedPagination: () => ({ meta: fixture.meta, refresh: () => {}, loadMore: fixture.loadMore }),
}));
vi.mock("@/features/profile/engagementCollector", () => ({
  useEngagementRange: () => (ids: readonly string[], startIndex: number) => {
    fixture.reported.push({ ids: [...ids], startIndex });
  },
}));
vi.mock("../FeedToolbar", () => ({ FeedToolbar: () => null }));
vi.mock("@/hooks/usePlaybackBarSpacing", () => ({
  usePlaybackBarSpacing: () => ({ scrollPaddingClass: "" }),
}));
vi.mock("@/hooks/useIsBlocked", () => ({ useIsBlocked: () => false }));
vi.mock("@/hooks/useUnblock", () => ({ useUnblock: () => () => {} }));
vi.mock("@/features/profile/useProfile", () => ({ useProfile: () => ({ profile: null }) }));
vi.mock("@/features/profile/UserPopoverContext", () => ({
  useUserPopover: () => ({ openUserPopover: () => {}, closeUserPopover: () => {} }),
}));
vi.mock("@/features/profile/NoteComposer", () => ({ NoteComposer: () => null }));
vi.mock("@/features/polls/PollNoteCard", () => ({ PollNoteCard: () => null }));
vi.mock("@/features/friends/FeedPrefsButton", () => ({ FeedPrefsButton: () => null }));
vi.mock("@/lib/media/useNoteMedia", () => ({
  useMusicNote: (event: NostrEvent) => ({ text: event.content, media: [], musicRefs: [] }),
}));
vi.mock("@/components/content/RichContent", () => ({
  RichContent: ({ content }: { content: string }) => <p data-testid="note-body">{content}</p>,
}));
vi.mock("../notes/NoteFooter", () => ({ NoteFooter: () => null }));

import { NotesFeed } from "../NotesFeed";

function renderFeed() {
  return renderWithProviders(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 220 }}>
      <NotesFeed />
    </VirtuosoMockContext.Provider>,
  );
}

beforeEach(() => {
  fixture.setNotes(0);
  fixture.meta = { isRefreshing: false, isLoadingMore: false, hasMore: true, loadMoreError: null };
  fixture.loadMore.mockReset();
  fixture.reported.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NotesFeed (virtualized)", () => {
  it("mounts a window of a 3000-note feed, not all of it", () => {
    fixture.setNotes(3000);
    renderFeed();
    const bodies = screen.getAllByTestId("note-body");
    expect(bodies.length).toBeGreaterThan(3);
    expect(bodies.length).toBeLessThan(40);
    expect(screen.getByText("body of note 0")).toBeInTheDocument();
    expect(screen.queryByText("body of note 2999")).toBeNull();
  });

  it("marks each card with its event id for scroll restoration", () => {
    fixture.setNotes(5);
    const { container } = renderFeed();
    const anchors = [...container.querySelectorAll("[data-feed-anchor]")].map((el) =>
      el.getAttribute("data-feed-anchor"),
    );
    expect(anchors).toEqual(["note-0", "note-1", "note-2", "note-3", "note-4"]);
  });

  it("requests engagement for the rendered range only", () => {
    fixture.setNotes(3000);
    renderFeed();
    expect(fixture.reported.length).toBeGreaterThan(0);
    const last = fixture.reported[fixture.reported.length - 1];
    expect(last.startIndex).toBe(0);
    expect(last.ids[0]).toBe("note-0");
    expect(last.ids.length).toBeLessThan(40);
    expect(last.ids).not.toContain("note-2999");
  });

  it("shows the empty state for a feed with no notes", () => {
    renderFeed();
    expect(screen.getByText("No notes yet from space members")).toBeInTheDocument();
    expect(screen.queryByTestId("note-body")).toBeNull();
  });

  it("keeps the manual load-more control under the list", () => {
    fixture.setNotes(5);
    renderFeed();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(fixture.loadMore).toHaveBeenCalledTimes(1);
  });

  it("shows the load-more error with a retry that calls loadMore again", () => {
    fixture.setNotes(5);
    fixture.meta = { ...fixture.meta, loadMoreError: "unreachable" };
    renderFeed();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't reach a relay to load more.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(fixture.loadMore).toHaveBeenCalledTimes(1);
    // The cards above are still there.
    expect(screen.getByText("body of note 0")).toBeInTheDocument();
  });

  it("shows the loading state while a page is being fetched, and the end marker after", () => {
    fixture.setNotes(5);
    fixture.meta = { ...fixture.meta, isLoadingMore: true };
    const first = renderFeed();
    expect(screen.getByRole("button", { name: /Loading/ })).toBeDisabled();
    first.unmount();

    fixture.meta = { ...fixture.meta, isLoadingMore: false, hasMore: false };
    renderFeed();
    expect(screen.getByText("No more to load")).toBeInTheDocument();
  });
});
