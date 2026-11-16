/**
 * Every route-level split: each lazy route renders its slot-filling fallback
 * first and then the real page through Suspense, with its props; a chunk that
 * fails to load shows the Reload fallback in the panel around it and recovers
 * on Try again.
 *
 * The feature modules are replaced by stubs so the test is about the lazy
 * wiring (which module, which export, which fallback), not about the pages.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { resetCrashLogForTests } from "@/lib/crash/crashLog";
import { setLazyImportsFailingForTests } from "@/lib/lazyWithRetry";

function stub(testId: string) {
  return function Stub(props: Record<string, unknown>) {
    return <div data-testid={testId} data-props={JSON.stringify(props)} />;
  };
}

vi.mock("@/features/settings/SettingsPage", () => ({ SettingsPage: stub("settings-page") }));
vi.mock("@/features/discover/DiscoverPage", () => ({ DiscoverPage: stub("discover-page") }));
vi.mock("@/features/dm/DMView", () => ({ DMView: stub("dm-view") }));
vi.mock("@/features/relay/RelayStatusPanel", () => ({ RelayStatusPanel: stub("relay-status") }));
vi.mock("@/features/profile/ProfilePage", () => ({ ProfilePage: stub("profile-page") }));
vi.mock("@/features/profile/NoteThreadPage", () => ({ NoteThreadPage: stub("note-thread") }));
vi.mock("@/features/longform/ArticlePage", () => ({ ArticlePage: stub("article-page") }));
vi.mock("@/features/longform/ArticleEditorPage", () => ({ ArticleEditorPage: stub("article-editor") }));
vi.mock("@/features/music/MusicRouter", () => ({ MusicRouter: stub("music-router") }));
vi.mock("@/features/music/MusicLinkResolver", () => ({ MusicLinkResolver: stub("music-link") }));
vi.mock("@/features/spaces/JoinSpaceModal", () => ({ JoinSpaceModal: stub("join-space") }));
vi.mock("@/features/onboarding/ProfileWizard", () => ({ ProfileWizard: stub("profile-wizard") }));
vi.mock("@/features/onboarding/AppTour", () => ({ AppTour: stub("app-tour") }));
vi.mock("@/features/music/MusicSidebar", () => ({ MusicSidebar: stub("music-sidebar") }));
vi.mock("@/features/dm/DMSidebar", () => ({ DMSidebar: stub("dm-sidebar") }));

import * as routes from "../lazyRoutes";
import { DMSidebar, MusicSidebar } from "@/components/layout/lazySidebars";
import { IDLE_PRELOADS, messagesIntent, musicIntent } from "../routePreload";

beforeEach(() => {
  localStorage.clear();
  resetCrashLogForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setLazyImportsFailingForTests(false);
  vi.restoreAllMocks();
});

interface RouteCase {
  name: keyof typeof routes;
  element: ReactElement;
  testId: string;
  /** What holds the slot while the chunk loads. */
  fallback: "panel" | "none";
  props?: Record<string, unknown>;
}

const noop = () => {};

const CASES: RouteCase[] = [
  { name: "SettingsPage", element: <routes.SettingsPage />, testId: "settings-page", fallback: "panel" },
  { name: "DiscoverPage", element: <routes.DiscoverPage />, testId: "discover-page", fallback: "panel" },
  { name: "DMView", element: <routes.DMView />, testId: "dm-view", fallback: "panel" },
  { name: "RelayStatusPanel", element: <routes.RelayStatusPanel />, testId: "relay-status", fallback: "panel" },
  {
    name: "ProfilePage",
    element: <routes.ProfilePage pubkey="pk1" />,
    testId: "profile-page",
    fallback: "panel",
    props: { pubkey: "pk1" },
  },
  {
    name: "NoteThreadPage",
    element: <routes.NoteThreadPage noteId="note1" />,
    testId: "note-thread",
    fallback: "panel",
    props: { noteId: "note1" },
  },
  { name: "ArticlePage", element: <routes.ArticlePage />, testId: "article-page", fallback: "panel" },
  { name: "ArticleEditorPage", element: <routes.ArticleEditorPage />, testId: "article-editor", fallback: "panel" },
  { name: "MusicRouter", element: <routes.MusicRouter />, testId: "music-router", fallback: "panel" },
  {
    name: "MusicLinkResolver",
    element: <routes.MusicLinkResolver type="album" />,
    testId: "music-link",
    fallback: "panel",
    props: { type: "album" },
  },
  {
    name: "JoinSpaceModal",
    element: <routes.JoinSpaceModal open onClose={noop} initialCode="abc" />,
    testId: "join-space",
    fallback: "none",
    props: { open: true, initialCode: "abc" },
  },
  { name: "ProfileWizard", element: <routes.ProfileWizard />, testId: "profile-wizard", fallback: "none" },
  { name: "AppTour", element: <routes.AppTour />, testId: "app-tour", fallback: "none" },
];

describe("lazy routes", () => {
  it("has a case for every export, so a new lazy route cannot ship untested", () => {
    expect(CASES.map((c) => c.name).sort()).toEqual(Object.keys(routes).sort());
  });

  // One test per route, in this order on purpose: a lazy component is a module
  // singleton, so its failure has to be exercised before its first successful
  // load. Each case walks the whole life of the chunk: loading → failed →
  // retried → rendered.
  it.each(CASES)(
    "$name: holds its slot while loading, shows Reload when the chunk fails, and renders after Try again",
    async ({ name, element, testId, fallback, props }) => {
      setLazyImportsFailingForTests(true); // what wiredDebug.failLazy(true) does
      const { container } = render(
        <ErrorBoundary variant="panel" label="center">
          {element}
        </ErrorBoundary>,
      );

      // First paint, chunk requested: a page holds its slot with the panel
      // fallback; an overlay draws nothing. Never the page itself.
      expect(screen.queryByTestId(testId)).toBeNull();
      const holder = container.querySelector("[data-lazy-fallback]");
      if (fallback === "panel") {
        expect(holder).toHaveAttribute("data-lazy-fallback", "panel");
        expect(holder).toHaveClass("flex-1");
      } else {
        expect(holder).toBeNull();
      }

      // The chunk failed: the boundary around it says so and offers Reload.
      const alert = await screen.findByRole("alert");
      expect(screen.getByRole("button", { name: "Reload app" })).toBeInTheDocument();
      if (name === "JoinSpaceModal") {
        // A modal brings its own boundary: a dialog that can be dismissed.
        expect(alert).toHaveAttribute("data-boundary-fallback", "modal");
        expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
      } else {
        expect(alert).toHaveTextContent("This part of the app didn't load");
      }
      expect(screen.queryByTestId(testId)).toBeNull();

      // Back online: Try again imports again and the page renders, with its props.
      setLazyImportsFailingForTests(false); // wiredDebug.failLazy(false)
      fireEvent.click(screen.getByRole("button", { name: /try again/i }));

      const loaded = await screen.findByTestId(testId);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(document.querySelector("[data-lazy-fallback]")).toBeNull();
      if (props) {
        expect(JSON.parse(loaded.getAttribute("data-props") ?? "{}")).toMatchObject(props);
      }
    },
  );

  it.each(CASES)("$name: once loaded, it renders straight away on a later visit", async ({ element, testId }) => {
    render(
      <ErrorBoundary variant="panel" label="center">
        {element}
      </ErrorBoundary>,
    );
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("lazy sidebars", () => {
  it.each([
    { name: "MusicSidebar", element: <MusicSidebar />, testId: "music-sidebar" },
    {
      name: "DMSidebar",
      element: <DMSidebar activePartner={null} onSelectContact={noop} />,
      testId: "dm-sidebar",
    },
  ])("$name renders through Suspense", async ({ element, testId }) => {
    const { container } = render(
      <ErrorBoundary variant="panel" label="sidebar.test">
        {element}
      </ErrorBoundary>,
    );
    expect(container.querySelector('[data-lazy-fallback="panel"]')).not.toBeNull();
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
    expect(container.querySelector("[data-lazy-fallback]")).toBeNull();
  });
});

describe("route preloading", () => {
  it("the Messages button warms the conversation view and its sidebar together", () => {
    const view = vi.spyOn(routes.DMView, "preload").mockImplementation(noop);
    const sidebar = vi.spyOn(DMSidebar, "preload").mockImplementation(noop);

    messagesIntent.preload();

    expect(view).toHaveBeenCalledTimes(1);
    expect(sidebar).toHaveBeenCalledTimes(1);
  });

  it("the Music button warms the section and its sidebar together", () => {
    const view = vi.spyOn(routes.MusicRouter, "preload").mockImplementation(noop);
    const sidebar = vi.spyOn(MusicSidebar, "preload").mockImplementation(noop);

    musicIntent.preload();

    expect(view).toHaveBeenCalledTimes(1);
    expect(sidebar).toHaveBeenCalledTimes(1);
  });

  it("idle preloading covers the first places people go, and leaves the rest for when they are opened", () => {
    const spies = {
      dm: vi.spyOn(routes.DMView, "preload").mockImplementation(noop),
      profile: vi.spyOn(routes.ProfilePage, "preload").mockImplementation(noop),
      note: vi.spyOn(routes.NoteThreadPage, "preload").mockImplementation(noop),
      music: vi.spyOn(routes.MusicRouter, "preload").mockImplementation(noop),
      discover: vi.spyOn(routes.DiscoverPage, "preload").mockImplementation(noop),
      settings: vi.spyOn(routes.SettingsPage, "preload").mockImplementation(noop),
      editor: vi.spyOn(routes.ArticleEditorPage, "preload").mockImplementation(noop),
      wizard: vi.spyOn(routes.ProfileWizard, "preload").mockImplementation(noop),
    };

    for (const target of IDLE_PRELOADS) target.preload();

    for (const key of ["dm", "profile", "note", "music", "discover"] as const) {
      expect(spies[key]).toHaveBeenCalledTimes(1);
    }
    for (const key of ["settings", "editor", "wizard"] as const) {
      expect(spies[key]).not.toHaveBeenCalled();
    }
  });
});
