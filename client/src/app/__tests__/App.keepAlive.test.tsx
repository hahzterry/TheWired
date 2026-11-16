/**
 * The music and AI sections are lazy chunks, but once opened they must stay
 * mounted: playback UI state, scroll positions and a streaming AI reply all
 * live in those trees and have to survive a sidebar switch.
 *
 * Renders the real App (router, auth gate, MainContent) with the shell and the
 * feature views replaced by stubs that count their mounts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useEffect, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { Outlet } from "react-router-dom";
import { createTestStore } from "@/__tests__/helpers/createTestStore";
import { setSidebarMode } from "@/store/slices/uiSlice";

const mounts = vi.hoisted(() => ({ music: 0, ai: 0, musicUnmounts: 0, aiUnmounts: 0, musicImports: 0 }));

vi.mock("../Layout", () => ({ Layout: () => <Outlet /> }));
vi.mock("@/features/identity/LoginScreen", () => ({ LoginScreen: () => <div data-testid="login" /> }));
vi.mock("@/features/spaces/SpaceView", () => ({
  SpaceView: ({ children }: { children?: ReactNode }) => <div data-testid="space-view">{children}</div>,
}));
vi.mock("@/features/spaces/ChannelPanel", () => ({ ChannelPanel: () => <div data-testid="channel-panel" /> }));
vi.mock("@/features/friends/FriendsFeedPanel", () => ({ FriendsFeedPanel: () => <div data-testid="friends" /> }));
vi.mock("@/features/music/MusicRouter", () => {
  mounts.musicImports += 1;
  return {
    MusicRouter: function MusicRouterStub() {
      useEffect(() => {
        mounts.music += 1;
        return () => {
          mounts.musicUnmounts += 1;
        };
      }, []);
      return <div data-testid="music-router" />;
    },
  };
});
vi.mock("@/features/ai/AIChatView", () => ({
  AIChatView: function AIChatViewStub() {
    useEffect(() => {
      mounts.ai += 1;
      return () => {
        mounts.aiUnmounts += 1;
      };
    }, []);
    return <div data-testid="ai-view" />;
  },
}));
vi.mock("@/lib/nostr/loginFlow", () => ({ tryRestoreSession: () => Promise.resolve() }));
vi.mock("@/features/settings/useEmbeddedRelayAutostart", () => ({ useEmbeddedRelayAutostart: () => {} }));
vi.mock("@/hooks/useAppUpdater", () => ({
  useAppUpdater: () => ({ status: "idle", version: null, progress: 0, error: null }),
}));
vi.mock("@/hooks/useZoomShortcuts", () => ({ useZoomShortcuts: () => {} }));
vi.mock("@/components/ZoomIndicator", () => ({ ZoomIndicator: () => null }));
vi.mock("@/components/UpdateOverlay", () => ({ UpdateOverlay: () => null }));
vi.mock("@/lib/debug/NavigationLogger", () => ({ NavigationLogger: () => null }));
vi.mock("@/contexts/ThemeContext", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));

import App from "../App";

function loggedInStore() {
  const base = createTestStore().getState();
  return createTestStore({
    identity: { ...base.identity, pubkey: "a".repeat(64) },
    features: { ...base.features, enabled: ["ai"] },
  });
}

async function renderApp() {
  const store = loggedInStore();
  const view = render(
    <Provider store={store}>
      <App />
    </Provider>,
  );
  // The auth gate shows "Starting..." until the session restore settles.
  await screen.findByTestId("space-view");
  return { store, ...view };
}

/** The keep-alive wrapper div around a view: `hidden` when its section is not showing. */
const wrapperOf = (testId: string) => screen.getByTestId(testId).closest("div.hidden, div.flex");

beforeEach(() => {
  window.history.pushState({}, "", "/");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App keep-alive sections", () => {
  it("does not load or mount the music section until it is first opened", async () => {
    await renderApp();

    expect(screen.queryByTestId("music-router")).toBeNull();
    expect(mounts.musicImports).toBe(0);
    expect(mounts.music).toBe(0);
  });

  it("opening music holds the panel while the chunk loads, then mounts it once and keeps it across sidebar switches", async () => {
    const { store, container } = await renderApp();

    act(() => {
      store.dispatch(setSidebarMode("music"));
    });
    // Chunk in flight: the slot is held, the spaces view is hidden, nothing shifts.
    expect(container.querySelector('[data-lazy-fallback="panel"]')).not.toBeNull();
    expect(screen.getByTestId("space-view").closest("div.hidden")).not.toBeNull();

    await screen.findByTestId("music-router");
    expect(mounts.music).toBe(1);
    expect(wrapperOf("music-router")).not.toHaveClass("hidden");

    // Away to spaces: hidden, not unmounted.
    act(() => {
      store.dispatch(setSidebarMode("spaces"));
    });
    expect(screen.getByTestId("music-router")).toBeInTheDocument();
    expect(wrapperOf("music-router")).toHaveClass("hidden");
    expect(mounts.musicUnmounts).toBe(0);

    // Through AI and back to music: still the same mounted instance.
    act(() => {
      store.dispatch(setSidebarMode("ai"));
    });
    await screen.findByTestId("ai-view");
    act(() => {
      store.dispatch(setSidebarMode("music"));
    });
    expect(wrapperOf("music-router")).not.toHaveClass("hidden");
    expect(mounts.music).toBe(1);
    expect(mounts.musicUnmounts).toBe(0);
  });

  it("the AI view also stays mounted once opened (a streaming reply survives leaving the tab)", async () => {
    const { store } = await renderApp();
    const before = { mounts: mounts.ai, unmounts: mounts.aiUnmounts };

    act(() => {
      store.dispatch(setSidebarMode("ai"));
    });
    await screen.findByTestId("ai-view");
    expect(mounts.ai).toBe(before.mounts + 1);

    act(() => {
      store.dispatch(setSidebarMode("spaces"));
    });
    act(() => {
      store.dispatch(setSidebarMode("music"));
    });
    await screen.findByTestId("music-router");

    expect(screen.getByTestId("ai-view")).toBeInTheDocument();
    expect(wrapperOf("ai-view")).toHaveClass("hidden");
    expect(mounts.aiUnmounts).toBe(before.unmounts);
  });
});
