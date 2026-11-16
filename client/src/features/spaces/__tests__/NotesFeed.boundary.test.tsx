/**
 * Regression: one note card that throws must not blank the feed.
 *
 * Renders the real NotesFeed and its real note card. Only the data hooks and
 * the leaf pieces that need a relay are stubbed; the footer stub is the fault
 * injection point, so the throw comes from inside a note card's own subtree.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import type { NostrEvent } from "@/types/nostr";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { getCrashRecords, resetCrashLogForTests } from "@/lib/crash/crashLog";

const fixture = vi.hoisted(() => {
  const note = (n: number): NostrEvent => ({
    id: `note-${n}`,
    pubkey: String(n).repeat(64),
    created_at: 1_700_000_000 + n,
    kind: 1,
    tags: [],
    content: `body of note ${n}`,
    sig: "",
  });
  const notes = [note(1), note(2), note(3)];
  return { notes, ids: notes.map((n) => n.id), explodeId: null as string | null };
});

vi.mock("../spaceSelectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../spaceSelectors")>()),
  selectSpaceRootNotes: () => fixture.notes,
  selectSpaceRootNoteIds: () => fixture.ids,
  selectActiveSpace: () => null,
}));
vi.mock("../useFeedPagination", () => ({
  useFeedPagination: () => ({
    meta: { isRefreshing: false, isLoadingMore: false, hasMore: false },
    refresh: () => {},
    loadMore: () => {},
  }),
}));
vi.mock("@/features/profile/engagementCollector", () => ({ useEngagementRange: () => () => {} }));
vi.mock("../FeedToolbar", () => ({ FeedToolbar: () => null }));
vi.mock("../LoadMoreButton", () => ({ LoadMoreButton: () => null }));
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
  RichContent: ({ content }: { content: string }) => <p>{content}</p>,
}));
vi.mock("../notes/NoteFooter", () => ({
  NoteFooter: ({ event }: { event: NostrEvent }) => {
    if (event.id === fixture.explodeId) throw new Error("note footer exploded");
    return <div data-testid={`footer-${event.id}`} />;
  },
}));

import { NotesFeed } from "../NotesFeed";

/** The feed is virtualized; jsdom has no layout, so give it a viewport that
 *  fits the three notes. */
function renderFeed() {
  return renderWithProviders(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 200 }}>
      <NotesFeed />
    </VirtuosoMockContext.Provider>,
  );
}

describe("NotesFeed error containment", () => {
  beforeEach(() => {
    fixture.explodeId = null;
    localStorage.clear();
    resetCrashLogForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders every note when nothing throws", () => {
    renderFeed();
    for (const n of [1, 2, 3]) expect(screen.getByText(`body of note ${n}`)).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a throwing note card leaves the rest of the feed mounted", () => {
    fixture.explodeId = "note-2";
    renderFeed();

    expect(screen.getByText("body of note 1")).toBeInTheDocument();
    expect(screen.getByText("body of note 3")).toBeInTheDocument();
    expect(screen.getByTestId("footer-note-1")).toBeInTheDocument();
    expect(screen.getByTestId("footer-note-3")).toBeInTheDocument();

    // The broken card is replaced by the compact fallback, in place.
    expect(screen.queryByText("body of note 2")).toBeNull();
    const fallbacks = screen.getAllByRole("status");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toHaveTextContent("This note couldn't be displayed.");

    const records = getCrashRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ boundary: "item:note", message: "note footer exploded" });
    // The record is about the failure, not the note.
    expect(JSON.stringify(records[0])).not.toContain("body of note");
  });

  it("retry brings the card back once it can render", () => {
    fixture.explodeId = "note-2";
    renderFeed();
    expect(screen.queryByText("body of note 2")).toBeNull();

    fixture.explodeId = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("body of note 2")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
