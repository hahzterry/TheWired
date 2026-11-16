/**
 * Channel views: chat, notes and media ship with the shell; reels, articles,
 * music and voice are lazy chunks that load the first time one is opened.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { createTestStore } from "@/__tests__/helpers/createTestStore";
import { setActiveChannel } from "@/store/slices/spacesSlice";
import { resetCrashLogForTests } from "@/lib/crash/crashLog";
import { setLazyImportsFailingForTests } from "@/lib/lazyWithRetry";
import type { SpaceChannel, SpaceChannelType } from "@/types/space";

const livekit = vi.hoisted(() => ({ preload: vi.fn() }));

function stub(testId: string) {
  return function Stub() {
    return <div data-testid={testId} />;
  };
}

vi.mock("@/features/chat/ChatView", () => ({ ChatView: stub("chat-view") }));
vi.mock("../NotesFeed", () => ({ NotesFeed: stub("notes-feed") }));
vi.mock("../MediaFeed", () => ({ MediaFeed: stub("media-feed") }));
vi.mock("@/features/media/ReelsView", () => ({ ReelsView: stub("reels-view") }));
vi.mock("@/features/longform/LongFormView", () => ({ LongFormView: stub("longform-view") }));
vi.mock("@/features/music/SpaceMusicView", () => ({ SpaceMusicView: stub("space-music") }));
vi.mock("@/features/voice/VoiceChannel", () => ({ VoiceChannel: stub("voice-channel") }));
vi.mock("@/lib/webrtc/livekit", () => ({ livekitPreload: { preload: livekit.preload } }));

import { ChannelPanel } from "../ChannelPanel";

const SPACE = "space1";

function channel(id: string, type: SpaceChannelType | "reels"): SpaceChannel {
  return {
    id,
    spaceId: SPACE,
    type,
    label: id,
    position: 0,
    isDefault: false,
    adminOnly: false,
    slowModeSeconds: 0,
  } as SpaceChannel;
}

const CHANNELS = [
  channel("general", "chat"),
  channel("notes", "notes"),
  channel("media", "media"),
  channel("reels", "reels"),
  channel("articles", "articles"),
  channel("tunes", "music"),
  channel("lounge", "voice"),
];

function renderPanel(activeChannel: string) {
  const base = createTestStore().getState();
  const store = createTestStore({
    spaces: {
      ...base.spaces,
      activeSpaceId: SPACE,
      activeChannelId: `${SPACE}:${activeChannel}`,
      channels: { [SPACE]: CHANNELS },
    },
  });
  return renderWithProviders(<ChannelPanel />, { store });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetCrashLogForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setLazyImportsFailingForTests(false);
  vi.restoreAllMocks();
});

describe("ChannelPanel", () => {
  it.each([
    ["general", "chat-view"],
    ["notes", "notes-feed"],
    ["media", "media-feed"],
  ])("the %s channel renders on the first paint, with no loading state", (id, testId) => {
    const { container } = renderPanel(id);
    expect(screen.getByTestId(testId)).toBeInTheDocument();
    expect(container.querySelector("[data-lazy-fallback]")).toBeNull();
  });

  // Failure first, then recovery: see the note in lazyRoutes.test.tsx.
  it.each([
    ["reels", "reels-view"],
    ["articles", "longform-view"],
    ["tunes", "space-music"],
    ["lounge", "voice-channel"],
  ])(
    "the %s channel holds its slot, shows Reload if its chunk fails, and renders after Try again",
    async (id, testId) => {
      setLazyImportsFailingForTests(true);
      const { container } = renderPanel(id);

      expect(screen.queryByTestId(testId)).toBeNull();
      expect(container.querySelector('[data-lazy-fallback="panel"]')).toHaveClass("flex-1");

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("This part of the app didn't load");
      expect(screen.getByRole("button", { name: "Reload app" })).toBeInTheDocument();

      setLazyImportsFailingForTests(false);
      fireEvent.click(screen.getByRole("button", { name: /try again/i }));

      expect(await screen.findByTestId(testId)).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      // Someone looking at a voice channel is about to join: the media SDK
      // starts downloading with the view, and only for that view.
      expect(livekit.preload).toHaveBeenCalledTimes(id === "lounge" ? 1 : 0);
    },
  );

  it("a channel view whose chunk failed leaves the other channels usable, and stays mounted once visited", async () => {
    const { store, container } = renderPanel("general");
    expect(screen.getByTestId("chat-view")).toBeInTheDocument();

    await act(async () => {
      store.dispatch(setActiveChannel(`${SPACE}:lounge`));
    });
    expect(await screen.findByTestId("voice-channel")).toBeInTheDocument();

    // Keep-alive: the chat view is hidden, not unmounted.
    const chat = screen.getByTestId("chat-view");
    expect(chat.closest(".hidden")).not.toBeNull();
    expect(container.querySelectorAll(".hidden")).toHaveLength(1);
  });
});
