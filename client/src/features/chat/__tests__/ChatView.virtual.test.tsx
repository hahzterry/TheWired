/**
 * The space chat list is virtualized. Regression cover for what must not
 * change: where the unread divider sits, reply jumps and jump-back, the
 * "New messages" hint, pending rows, and error containment per row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { NostrEvent } from "@/types/nostr";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { createTestStore } from "@/__tests__/helpers/createTestStore";
import { VirtualViewport, userScrollTo, virtualListSettled } from "@/__tests__/helpers/virtualList";

const ME = "aa".repeat(32);
const SPACE = "space-1";
const CHANNEL = "space-1:general";

const fixture = vi.hoisted(() => {
  interface View {
    event: NostrEvent;
    isEdited: boolean;
    displayContent: string;
  }
  const state = {
    messages: [] as View[],
    pending: [] as { tempId: string; content: string; status: "pending" | "confirmed" | "failed" }[],
    explodeId: null as string | null,
    retry: vi.fn(),
    make(n: number, createdAt = 1_700_000_000 + n): View {
      const event: NostrEvent = {
        id: `msg-${n}`,
        pubkey: "bb".repeat(32),
        created_at: createdAt,
        kind: 9,
        tags: [],
        content: `message ${n}`,
        sig: "",
      };
      return { event, isEdited: false, displayContent: event.content };
    },
    fill(count: number) {
      state.messages = Array.from({ length: count }, (_, i) => state.make(i));
    },
  };
  return state;
});

vi.mock("../useChat", () => ({
  useChat: () => ({
    messages: fixture.messages,
    pendingMessages: fixture.pending,
    replyTo: null,
    setReplyTo: () => {},
    sendMessage: () => {},
    sendPoll: () => {},
    relayTargets: [],
    retryMessage: fixture.retry,
    editingMessage: null,
    setEditingMessage: () => {},
    deleteMessageForMe: () => {},
    deleteMessageForEveryone: () => {},
    modDeleteMessage: () => Promise.resolve(),
    editMessage: () => {},
    canEdit: () => false,
  }),
}));
// A light stand-in for the real message row: its text, and a button that
// jumps to the message it "replies" to (the first message of the channel).
vi.mock("../ChatMessage", () => ({
  ChatMessage: ({ event, onJumpToMessage }: { event: NostrEvent; onJumpToMessage?: (id: string) => void }) => {
    if (event.id === fixture.explodeId) throw new Error("chat row exploded");
    return (
      <div data-testid="chat-row">
        <span>{event.content}</span>
        <button onClick={() => onJumpToMessage?.("msg-0")}>jump from {event.id}</button>
      </div>
    );
  },
}));
vi.mock("../ChatInput", () => ({ ChatInput: () => <div data-testid="composer" /> }));
vi.mock("../ChatReply", () => ({ ChatReply: () => null }));
vi.mock("../ChatEditBanner", () => ({ ChatEditBanner: () => null }));
vi.mock("@/hooks/useFileUpload", () => ({
  useFileUpload: () => ({
    attachments: [],
    addFiles: vi.fn(),
    removeAttachment: vi.fn(),
    retryAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    openFilePicker: vi.fn(),
    handleFileInputChange: vi.fn(),
    fileInputRef: { current: null },
    dropZoneRef: { current: null },
    dragOver: false,
    isUploading: false,
    hasAttachments: false,
  }),
}));
vi.mock("@/hooks/usePlaybackBarSpacing", () => ({
  usePlaybackBarSpacing: () => ({ scrollPaddingClass: "", scrollPaddingPx: 0, inputMarginClass: "" }),
}));
vi.mock("@/features/profile/UserPopoverContext", () => ({
  useUserPopover: () => ({ openUserPopover: () => {}, closeUserPopover: () => {} }),
}));
vi.mock("@/features/spaces/usePermissions", () => ({
  usePermissions: () => ({ can: () => true, permissions: [] }),
}));
vi.mock("@/features/polls/usePollVotesSub", () => ({ usePollVotesSub: () => {} }));
vi.mock("@/lib/nostr/profileCache", () => ({ profileCache: { warmPubkeys: () => {} } }));
vi.mock("@/components/content/RichContent", () => ({
  RichContent: ({ content }: { content: string }) => <span>{content}</span>,
}));

import { ChatView } from "../ChatView";

function makeStore(dividerTimestamp?: number) {
  const base = createTestStore().getState();
  return createTestStore({
    ...base,
    identity: { ...base.identity, pubkey: ME },
    spaces: { ...base.spaces, activeSpaceId: SPACE, activeChannelId: CHANNEL },
    notifications: {
      ...base.notifications,
      unreadDividerTimestamps: dividerTimestamp === undefined ? {} : { [CHANNEL]: dividerTimestamp },
    },
  });
}

function renderChat(dividerTimestamp?: number) {
  const store = makeStore(dividerTimestamp);
  // A new element each time, so a re-render really re-reads the fixture.
  const ui = () => (
    <VirtualViewport height={600} rowHeight={50}>
      <ChatView />
    </VirtualViewport>
  );
  const result = renderWithProviders(ui(), { store });
  return { ...result, refresh: () => result.rerender(ui()) };
}

const scroller = (container: HTMLElement) =>
  container.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement;

/** Scroll the reader up into history. */
function scrollUp(container: HTMLElement) {
  // From the bottom, up: only an upward move counts as leaving the bottom.
  act(() => userScrollTo(scroller(container), { scrollTop: 19_400, scrollHeight: 20_000, clientHeight: 600 }));
  act(() => userScrollTo(scroller(container), { scrollTop: 500, scrollHeight: 20_000, clientHeight: 600 }));
}

beforeEach(() => {
  fixture.messages = [];
  fixture.pending = [];
  fixture.explodeId = null;
  fixture.retry.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ChatView (virtualized)", () => {
  it("mounts a window of a 3000-message channel and opens on the newest message", async () => {
    fixture.fill(3000);
    renderChat();
    await virtualListSettled();
    const rows = screen.getAllByTestId("chat-row");
    expect(rows.length).toBeLessThan(80);
    expect(screen.getByText("message 2999")).toBeInTheDocument();
    expect(screen.queryByText("message 0")).toBeNull();
  });

  it("shows the empty state for a channel with no messages", () => {
    renderChat();
    expect(screen.getByText("No messages yet. Start the conversation!")).toBeInTheDocument();
  });

  it("keeps every row keyed by its event id with its data-event-id marker", async () => {
    fixture.fill(5);
    const { container } = renderChat();
    await virtualListSettled();
    const ids = [...container.querySelectorAll("[data-event-id]")].map((el) => el.getAttribute("data-event-id"));
    expect(ids).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]);
  });

  describe("unread divider", () => {
    it("sits directly above the first message newer than the last-read time", async () => {
      fixture.fill(10); // created_at = base + n
      const { container } = renderChat(1_700_000_000 + 6); // read up to message 6
      await virtualListSettled();
      const divider = screen.getByText("New messages");
      const row = divider.closest("[data-event-id]")!;
      expect(row.getAttribute("data-event-id")).toBe("msg-7");
      // Above the message inside that row, and only once in the list.
      expect(
        divider.compareDocumentPosition(within(row as HTMLElement).getByText("message 7")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(container.querySelectorAll("[data-event-id]")).toHaveLength(10);
      expect(screen.getAllByText("New messages")).toHaveLength(1);
    });

    it("is not shown when everything was read or there is no last-read time", async () => {
      fixture.fill(10);
      const read = renderChat(1_700_000_000 + 50);
      await virtualListSettled();
      expect(screen.queryByText("New messages")).toBeNull();
      read.unmount();

      renderChat();
      await virtualListSettled();
      expect(screen.queryByText("New messages")).toBeNull();
    });

    it("opens the channel on the divider, away from the bottom", async () => {
      fixture.fill(3000);
      renderChat(1_700_000_000 + 1499); // first unread is message 1500
      await virtualListSettled();
      expect(screen.getByText("New messages").closest("[data-event-id]")!.getAttribute("data-event-id")).toBe(
        "msg-1500",
      );
      expect(screen.queryByText("message 2999")).toBeNull();
    });

    it("clears itself after its time is up, even when its row is not mounted", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      fixture.fill(10);
      const { store } = renderChat(1_700_000_000 + 6);
      await virtualListSettled();
      expect(store.getState().notifications.unreadDividerTimestamps[CHANNEL]).toBeDefined();
      act(() => {
        vi.advanceTimersByTime(8_600);
      });
      expect(store.getState().notifications.unreadDividerTimestamps[CHANNEL]).toBeUndefined();
    });
  });

  describe("jump to message", () => {
    it("jumps to a reply's target that is not rendered, and offers the way back", async () => {
      fixture.fill(3000);
      renderChat();
      await virtualListSettled();
      expect(screen.queryByText("message 0")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "jump from msg-2999" }));
      expect(screen.getByRole("button", { name: "Jump back" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Jump back" }));
      expect(screen.queryByRole("button", { name: "Jump back" })).toBeNull();
    });

    it("flashes the target row when it is on screen", async () => {
      fixture.fill(5);
      const { container } = renderChat();
      await virtualListSettled();
      fireEvent.click(screen.getByRole("button", { name: "jump from msg-4" }));
      const target = container.querySelector('[data-event-id="msg-0"]')!;
      expect(target.className).toContain("animate-highlight-flash");
      // Only the target flashes.
      expect(container.querySelector('[data-event-id="msg-3"]')!.className).not.toContain("animate-highlight-flash");
    });

    it("does nothing when the target message is not in the channel", async () => {
      fixture.messages = [fixture.make(5), fixture.make(6)]; // msg-0 is absent
      renderChat();
      await virtualListSettled();
      fireEvent.click(screen.getByRole("button", { name: "jump from msg-6" }));
      expect(screen.queryByRole("button", { name: "Jump back" })).toBeNull();
    });
  });

  describe("new messages", () => {
    it("raises the 'New messages' hint for a message arriving while reading history", async () => {
      fixture.fill(200);
      const { container, refresh } = renderChat();
      await virtualListSettled();
      scrollUp(container);
      expect(screen.getByTitle("Scroll to bottom")).toBeInTheDocument();
      expect(screen.queryByText("New messages")).toBeNull();

      fixture.messages = [...fixture.messages, fixture.make(200)];
      refresh();
      expect(screen.getByTitle("Scroll to bottom")).toHaveTextContent("New messages");
    });

    it("does not raise the hint while the reader is at the bottom", async () => {
      fixture.fill(200);
      const { refresh } = renderChat();
      await virtualListSettled();
      fixture.messages = [...fixture.messages, fixture.make(200)];
      refresh();
      expect(screen.queryByTitle("Scroll to bottom")).toBeNull();
    });

    it("does not raise the hint for history arriving above", async () => {
      fixture.messages = Array.from({ length: 200 }, (_, i) => fixture.make(i + 100));
      const { container, refresh } = renderChat();
      await virtualListSettled();
      scrollUp(container);
      fixture.messages = [...Array.from({ length: 100 }, (_, i) => fixture.make(i)), ...fixture.messages];
      refresh();
      expect(screen.getByTitle("Scroll to bottom")).not.toHaveTextContent("New messages");
    });

    it("an own send never raises the hint, wherever the reader is", async () => {
      fixture.fill(200);
      const { container, refresh } = renderChat();
      await virtualListSettled();
      scrollUp(container);
      fixture.pending = [{ tempId: "temp_1", content: "sending this", status: "pending" }];
      refresh();
      expect(screen.getByTitle("Scroll to bottom")).not.toHaveTextContent("New messages");
    });

    it("clears the hint when the reader returns to the bottom", async () => {
      fixture.fill(200);
      const { container, refresh } = renderChat();
      await virtualListSettled();
      scrollUp(container);
      fixture.messages = [...fixture.messages, fixture.make(200)];
      refresh();
      act(() => userScrollTo(scroller(container), { scrollTop: 19_400, scrollHeight: 20_000, clientHeight: 600 }));
      expect(screen.queryByTitle("Scroll to bottom")).toBeNull();
    });
  });

  it("renders a message still sending after the confirmed ones, with retry when it failed", async () => {
    fixture.fill(3);
    fixture.pending = [{ tempId: "temp_1", content: "did not send", status: "failed" }];
    const { container } = renderChat();
    await virtualListSettled();
    const pending = screen.getByText("did not send");
    const lastConfirmed = container.querySelector('[data-event-id="msg-2"]')!;
    expect(lastConfirmed.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(pending.closest(".opacity-60")!.querySelector("button")!);
    expect(fixture.retry).toHaveBeenCalledWith("temp_1");
  });

  it("a throwing message shows its inline fallback and leaves its neighbours mounted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.fill(5);
    fixture.explodeId = "msg-2";
    renderChat();
    await virtualListSettled();
    expect(screen.getByText("message 1")).toBeInTheDocument();
    expect(screen.getByText("message 3")).toBeInTheDocument();
    expect(screen.queryByText("message 2")).toBeNull();
    const fallbacks = screen.getAllByRole("status");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toHaveTextContent("This message couldn't be displayed.");
  });
});
