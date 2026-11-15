/**
 * The DM conversation list is virtualized. Regression cover for what must not
 * change: where the unread divider and date separators sit, reply and search
 * jumps, the scroll-to-bottom button, and error containment per message.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { createTestStore, type TestStore } from "@/__tests__/helpers/createTestStore";
import { VirtualViewport, setScrollGeometry, virtualListSettled } from "@/__tests__/helpers/virtualList";
import { lunaVega, riverChen } from "@/__tests__/fixtures/testUsers";
import { dmSlice, type DMMessage as DMMessageType } from "@/store/slices/dmSlice";

const ME = lunaVega.pubkey;
const PEER = riverChen.pubkey;

const fixture = vi.hoisted(() => ({
  explodeWrapId: null as string | null,
  searchJump: null as null | ((result: { wrapId?: string }) => void),
}));

vi.mock("../dmService", () => ({
  sendDM: vi.fn(),
  sendDMFile: vi.fn(),
  resendDM: vi.fn(),
  editDM: vi.fn(),
  deleteDMForEveryone: vi.fn(),
  reactToDM: vi.fn(),
  removeDMReaction: vi.fn(),
  sendTyping: vi.fn(),
  sendReceipt: vi.fn(() => Promise.resolve(false)),
}));
// A light stand-in for the real bubble: its text, and a button that jumps to
// the message it "replies" to (the first message of the conversation).
vi.mock("../DMMessage", () => ({
  DMMessage: ({
    message,
    isGrouped,
    onJumpToMessage,
  }: {
    message: DMMessageType;
    isGrouped: boolean;
    onJumpToMessage?: (wrapId: string) => void;
  }) => {
    if (message.wrapId === fixture.explodeWrapId) throw new Error("dm bubble exploded");
    return (
      <div data-testid="dm-row" data-grouped={isGrouped ? "yes" : "no"}>
        <span>{message.content}</span>
        <button onClick={() => onJumpToMessage?.("w-0")}>jump from {message.wrapId}</button>
      </div>
    );
  },
}));
vi.mock("../DMInput", () => ({ DMInput: () => <div data-testid="composer" /> }));
vi.mock("../../calling/useCall", () => ({ useCall: () => ({ startCall: vi.fn(), isInCall: false }) }));
vi.mock("../../wallet/WalletProvider", () => ({ useZap: () => ({ openZap: vi.fn() }) }));
vi.mock("../../profile/useProfile", () => ({ useProfile: () => ({ profile: null }) }));
vi.mock("@/features/profile/UserPopoverContext", () => ({
  useUserPopover: () => ({ openUserPopover: () => {}, closeUserPopover: () => {} }),
}));
vi.mock("../useFriends", () => ({ useFriends: () => [] }));
vi.mock("@/hooks/usePlaybackBarSpacing", () => ({
  usePlaybackBarSpacing: () => ({ scrollPaddingClass: "", scrollPaddingPx: 0, inputMarginClass: "" }),
}));
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
vi.mock("@/features/search/SearchPanel", () => ({
  SearchPanel: ({ onJumpToMessage }: { onJumpToMessage?: (result: { wrapId?: string }) => void }) => {
    fixture.searchJump = onJumpToMessage ?? null;
    return <div data-testid="search-panel" />;
  },
}));

import { DMConversation } from "../DMConversation";

const DAY = 86_400;
/** Noon UTC on a fixed day, so "same day" holds in every timezone the tests run in. */
const T0 = Date.UTC(2026, 5, 10, 12, 0, 0) / 1000;

function message(n: number, createdAt = T0 + n, sender = n % 2 === 0 ? PEER : ME): DMMessageType {
  return { id: `id-${n}`, senderPubkey: sender, content: `dm ${n}`, createdAt, wrapId: `w-${n}`, rumorId: `r-${n}` };
}

function makeStore(messages: DMMessageType[], unread = 0): TestStore {
  const base = createTestStore().getState();
  return createTestStore({
    ...base,
    identity: { ...base.identity, pubkey: ME },
    dm: {
      ...base.dm,
      messages: { [PEER]: messages },
      unreadDividers: unread > 0 ? { [PEER]: unread } : {},
    },
  });
}

function renderDM(messages: DMMessageType[], unread = 0) {
  const store = makeStore(messages, unread);
  const result = renderWithProviders(
    <VirtualViewport height={600} rowHeight={60}>
      <DMConversation partnerPubkey={PEER} onBack={() => {}} />
    </VirtualViewport>,
    { store },
  );
  return { ...result, store };
}

const scroller = (container: HTMLElement) =>
  container.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement;

beforeEach(() => {
  fixture.explodeWrapId = null;
  fixture.searchJump = null;
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DMConversation (virtualized)", () => {
  it("mounts a window of a 3000-message conversation and opens on the newest message", async () => {
    renderDM(Array.from({ length: 3000 }, (_, i) => message(i)));
    await virtualListSettled();
    expect(screen.getAllByTestId("dm-row").length).toBeLessThan(80);
    expect(screen.getByText("dm 2999")).toBeInTheDocument();
    expect(screen.queryByText("dm 0")).toBeNull();
  });

  it("shows the empty state with no messages", () => {
    renderDM([]);
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
  });

  it("keeps every row keyed by its wrap id with its data-wrap-id marker", async () => {
    const { container } = renderDM([0, 1, 2].map((n) => message(n)));
    await virtualListSettled();
    expect([...container.querySelectorAll("[data-wrap-id]")].map((el) => el.getAttribute("data-wrap-id"))).toEqual([
      "w-0",
      "w-1",
      "w-2",
    ]);
  });

  describe("unread divider", () => {
    it("sits above the first of the unread messages, counted from the end", async () => {
      renderDM(Array.from({ length: 10 }, (_, i) => message(i)), 3);
      await virtualListSettled();
      const divider = screen.getByText("New messages");
      const row = divider.closest("[data-wrap-id]")!;
      expect(row.getAttribute("data-wrap-id")).toBe("w-7");
      expect(divider.compareDocumentPosition(screen.getByText("dm 7")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getAllByText("New messages")).toHaveLength(1);
    });

    it("is not shown when nothing was unread", async () => {
      renderDM(Array.from({ length: 10 }, (_, i) => message(i)));
      await virtualListSettled();
      expect(screen.queryByText("New messages")).toBeNull();
    });

    it("opens the conversation on the divider, away from the bottom", async () => {
      renderDM(Array.from({ length: 3000 }, (_, i) => message(i)), 1500);
      await virtualListSettled();
      expect(screen.getByText("New messages").closest("[data-wrap-id]")!.getAttribute("data-wrap-id")).toBe("w-1500");
      expect(screen.queryByText("dm 2999")).toBeNull();
    });

    it("clears itself after its time is up", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { store } = renderDM(Array.from({ length: 10 }, (_, i) => message(i)), 3);
      await virtualListSettled();
      expect(store.getState().dm.unreadDividers[PEER]).toBe(3);
      act(() => {
        vi.advanceTimersByTime(8_600);
      });
      expect(store.getState().dm.unreadDividers[PEER]).toBeUndefined();
    });
  });

  it("draws a date separator above the first message of each day and groups runs from one sender", async () => {
    const messages = [
      message(0, T0, PEER),
      message(1, T0 + 60, PEER), // same sender, same day: grouped
      message(2, T0 + 120, ME),
      message(3, T0 + DAY, ME), // next day: separator, not grouped
    ];
    const { container } = renderDM(messages);
    await virtualListSettled();
    const separators = [...container.querySelectorAll("[data-wrap-id]")].map(
      (row) => row.querySelectorAll(".uppercase.tracking-wider").length,
    );
    expect(separators).toEqual([1, 0, 0, 1]);
    expect(screen.getAllByTestId("dm-row").map((el) => el.dataset.grouped)).toEqual(["no", "yes", "no", "no"]);
  });

  describe("jump to message", () => {
    it("jumps to a reply's target that is not rendered, and offers the way back", async () => {
      renderDM(Array.from({ length: 3000 }, (_, i) => message(i)));
      await virtualListSettled();
      fireEvent.click(screen.getByRole("button", { name: "jump from w-2999" }));
      expect(screen.getByRole("button", { name: "Jump back" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Jump back" }));
      expect(screen.queryByRole("button", { name: "Jump back" })).toBeNull();
    });

    it("flashes the target row when it is on screen", async () => {
      const { container } = renderDM([0, 1, 2, 3].map((n) => message(n)));
      await virtualListSettled();
      fireEvent.click(screen.getByRole("button", { name: "jump from w-3" }));
      expect(container.querySelector('[data-wrap-id="w-0"]')!.className).toContain("animate-highlight-flash");
      expect(container.querySelector('[data-wrap-id="w-2"]')!.className).not.toContain("animate-highlight-flash");
    });

    it("a search result jumps to its message and flashes it; an unknown one does nothing", async () => {
      const { container } = renderDM([0, 1, 2, 3].map((n) => message(n)));
      await virtualListSettled();
      fireEvent.click(screen.getByTitle("Search conversation"));
      expect(fixture.searchJump).not.toBeNull();

      act(() => fixture.searchJump!({ wrapId: "w-1" }));
      expect(container.querySelector('[data-wrap-id="w-1"]')!.className).toContain("animate-highlight-flash");

      act(() => fixture.searchJump!({ wrapId: "not-here" }));
      expect(container.querySelector('[data-wrap-id="w-1"]')!.className).toContain("animate-highlight-flash");
      expect(container.querySelectorAll(".animate-highlight-flash")).toHaveLength(1);
    });
  });

  it("offers scroll-to-bottom only while the reader is up in history (60px threshold)", async () => {
    const { container } = renderDM(Array.from({ length: 200 }, (_, i) => message(i)));
    await virtualListSettled();
    expect(screen.queryByTitle("Scroll to bottom")).toBeNull();

    act(() => setScrollGeometry(scroller(container), { scrollTop: 9339, scrollHeight: 10_000, clientHeight: 600 })); // 61px
    expect(screen.getByTitle("Scroll to bottom")).toBeInTheDocument();

    act(() => setScrollGeometry(scroller(container), { scrollTop: 9341, scrollHeight: 10_000, clientHeight: 600 })); // 59px
    expect(screen.queryByTitle("Scroll to bottom")).toBeNull();
  });

  it("picks up a message arriving live", async () => {
    const { store } = renderDM([0, 1, 2].map((n) => message(n)));
    await virtualListSettled();
    act(() => {
      store.dispatch(
        dmSlice.actions.addDMMessage({ partnerPubkey: PEER, myPubkey: ME, message: message(3, T0 + 500, PEER) }),
      );
    });
    expect(await screen.findByText("dm 3")).toBeInTheDocument();
  });

  it("a throwing message shows its inline fallback and leaves its neighbours mounted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.explodeWrapId = "w-2";
    renderDM([0, 1, 2, 3, 4].map((n) => message(n)));
    await virtualListSettled();
    expect(screen.getByText("dm 1")).toBeInTheDocument();
    expect(screen.getByText("dm 3")).toBeInTheDocument();
    expect(screen.queryByText("dm 2")).toBeNull();
    const fallbacks = screen.getAllByRole("status");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toHaveTextContent("This message couldn't be displayed.");
  });
});
