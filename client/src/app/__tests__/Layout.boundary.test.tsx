/**
 * Regression: one shell panel that throws must leave the shell and the other
 * panels mounted and usable.
 *
 * Renders the real Layout with the real Sidebar, TopBar, CenterPanel and
 * RightPanel. Their feature children are replaced by stubs that throw on
 * demand, which is the fault injection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReactNode } from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import { Link, Route, Routes } from "react-router-dom";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { getCrashRecords, resetCrashLogForTests } from "@/lib/crash/crashLog";

const boom = vi.hoisted(() => ({
  sidebar: false,
  topbar: false,
  rightTab: false,
  page: false,
  toasts: false,
}));

function stub(testId: string, flag?: keyof typeof boom) {
  return function Stub() {
    if (flag && boom[flag]) throw new Error(`${testId} exploded`);
    return <div data-testid={testId} />;
  };
}

function passthrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

// Sidebar children
vi.mock("@/features/spaces/SpaceList", () => ({ SpaceList: stub("space-list", "sidebar") }));
vi.mock("@/features/spaces/ChannelList", () => ({ ChannelList: stub("channel-list") }));
vi.mock("@/features/music/MusicSidebar", () => ({ MusicSidebar: stub("music-sidebar") }));
vi.mock("@/features/dm/DMSidebar", () => ({ DMSidebar: stub("dm-sidebar") }));
vi.mock("@/features/identity/ProfileCard", () => ({ ProfileCard: stub("profile-card") }));
vi.mock("@/features/voice/VoiceStatusBar", () => ({ VoiceStatusBar: stub("voice-status") }));
vi.mock("@/features/dm/useDMContacts", () => ({ useDMUnreadCount: () => 0 }));
vi.mock("@/features/ai/AISidebar", () => ({ AISidebar: stub("ai-sidebar") }));
// TopBar children
vi.mock("@/features/music/SearchInput", () => ({ SearchInput: stub("music-search") }));
vi.mock("@/features/search/UserSearchInput", () => ({ UserSearchInput: stub("user-search") }));
vi.mock("@/features/notifications/NotificationBell", () => ({
  NotificationBell: stub("notification-bell", "topbar"),
}));
vi.mock("@/components/layout/ThemeQuickPicker", () => ({ ThemeQuickPicker: stub("theme-picker") }));
vi.mock("@/features/profile/useProfile", () => ({ useProfile: () => ({ profile: null }) }));
vi.mock("@/hooks/useNavigationHistory", () => ({
  MUSIC_DETAIL_VIEWS: new Set(),
  useNavigationHistory: () => ({
    canGoBack: false,
    canGoForward: false,
    goBack: () => {},
    goForward: () => {},
  }),
}));
// RightPanel children
vi.mock("@/components/layout/useRightPanelContext", () => ({
  useRightPanelContext: () => ({
    context: "space",
    isOpen: true,
    activeTab: "members",
    tabs: [
      { id: "members", label: "Members" },
      { id: "info", label: "Info" },
    ],
    toggle: () => {},
    setTab: () => {},
  }),
}));
vi.mock("@/features/spaces/MemberList", () => ({ MemberList: stub("member-list", "rightTab") }));
vi.mock("@/features/spaces/SpaceInfoPanel", () => ({ SpaceInfoPanel: stub("space-info") }));
vi.mock("@/features/music/QueueContent", () => ({ QueueContent: stub("queue") }));
vi.mock("@/features/music/NowPlayingDetail", () => ({ NowPlayingDetail: stub("now-playing") }));
vi.mock("@/features/dm/DMContactPanel", () => ({ DMContactPanel: stub("dm-contact") }));
vi.mock("@/features/profile/ProfileSidePanel", () => ({ ProfileSidePanel: stub("profile-side") }));
vi.mock("@/features/discover/SpacePreviewPanel", () => ({ SpacePreviewPanel: stub("space-preview") }));
vi.mock("@/features/ai/artifacts/ArtifactsPanel", () => ({ ArtifactsPanel: stub("artifacts") }));
// Layout chrome
vi.mock("@/components/layout/ThemeBackground", () => ({ ThemeBackground: () => null }));
vi.mock("@/features/music/playbackBar/FloatingPlaybackBar", () => ({
  FloatingPlaybackBar: stub("playback-bar"),
}));
vi.mock("@/features/profile/UserPopoverContext", () => ({ UserPopoverProvider: passthrough }));
vi.mock("@/features/notifications/NotificationToast", () => ({
  NotificationToastStack: stub("toasts", "toasts"),
}));
vi.mock("@/features/wallet/WalletProvider", () => ({ WalletProvider: passthrough }));
vi.mock("@/features/ai/AIProvider", () => ({ AIProvider: () => null }));
vi.mock("@/features/calling/CallController", () => ({ CallController: stub("call") }));
vi.mock("@/features/calling/IncomingCallBanner", () => ({ IncomingCallBanner: stub("incoming") }));
vi.mock("@/features/calling/CallNotice", () => ({ CallNotice: stub("call-notice") }));
vi.mock("@/features/voice/ScreenSharePill", () => ({ ScreenSharePill: stub("screen-share") }));
vi.mock("@/hooks/useExternalLinkHandler", () => ({ useExternalLinkHandler: () => {} }));
vi.mock("@/hooks/useCallShortcuts", () => ({ useCallShortcuts: () => {} }));

import { Layout } from "../Layout";
import { BoundaryResetProvider } from "../BoundaryResetProvider";

function FeedPage() {
  if (boom.page) throw new Error("feed page exploded");
  return (
    <div data-testid="feed-page">
      feed <Link to="/settings">go to settings</Link>
    </div>
  );
}

function renderShell() {
  return renderWithProviders(
    <BoundaryResetProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<FeedPage />} />
          <Route path="settings" element={<div data-testid="settings-page">settings</div>} />
        </Route>
      </Routes>
      <Link to="/settings">outside link</Link>
    </BoundaryResetProvider>,
  );
}

function fallbackFor(label: string) {
  return getCrashRecords().filter((r) => r.boundary === label);
}

describe("Layout error containment", () => {
  beforeEach(() => {
    for (const key of Object.keys(boom) as Array<keyof typeof boom>) boom[key] = false;
    localStorage.clear();
    resetCrashLogForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders all four panels when nothing throws", () => {
    renderShell();
    for (const id of ["space-list", "notification-bell", "feed-page", "member-list", "toasts"]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a throwing sidebar leaves the top bar, the page and the right panel mounted", () => {
    boom.sidebar = true;
    renderShell();

    expect(screen.getByRole("alert")).toHaveTextContent("This part of the app hit a problem");
    expect(screen.queryByTestId("space-list")).toBeNull();
    for (const id of ["notification-bell", "feed-page", "member-list", "toasts"]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(fallbackFor("panel:sidebar")).toHaveLength(1);

    // The rest of the shell is not just mounted but usable.
    fireEvent.click(screen.getByText("go to settings"));
    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
  });

  it("the sidebar recovers on retry", () => {
    boom.sidebar = true;
    renderShell();
    boom.sidebar = false;
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: /try again/i }));
    expect(screen.getByTestId("space-list")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a throwing top bar keeps a bar in place and leaves the panels mounted", () => {
    boom.topbar = true;
    renderShell();

    expect(screen.getByRole("status")).toHaveTextContent("This toolbar couldn't be displayed.");
    for (const id of ["space-list", "feed-page", "member-list"]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(fallbackFor("panel:topbar")).toHaveLength(1);

    boom.topbar = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByTestId("notification-bell")).toBeInTheDocument();
  });

  it("a throwing right-panel tab keeps the panel header and the other panels", () => {
    boom.rightTab = true;
    renderShell();

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("member-list")).toBeNull();
    // The sibling tab in the same panel and the panel's tab bar survive.
    expect(screen.getByTestId("space-info")).toBeInTheDocument();
    expect(screen.getAllByText("Members").length).toBeGreaterThan(0);
    for (const id of ["space-list", "notification-bell", "feed-page"]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(fallbackFor("panel:right.members")).toHaveLength(1);
  });

  it("a throwing page is contained to the center panel and clears on navigation", () => {
    boom.page = true;
    renderShell();

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("feed-page")).toBeNull();
    for (const id of ["space-list", "notification-bell", "member-list"]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(fallbackFor("panel:center")).toHaveLength(1);

    // Navigating away resets the boundary without pressing anything in it.
    fireEvent.click(screen.getByText("outside link"));
    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a throwing overlay disappears without taking the shell with it", () => {
    boom.toasts = true;
    renderShell();

    expect(screen.queryByTestId("toasts")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    for (const id of ["space-list", "notification-bell", "feed-page", "member-list"]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(fallbackFor("overlay:toasts")).toHaveLength(1);
  });
});
