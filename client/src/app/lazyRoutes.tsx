/**
 * The app's route-level code splits.
 *
 * Each export is a drop-in for the component it loads: same name, same props,
 * with its Suspense fallback built in (`lazyView` / `lazyModal`), and a
 * `preload()` used by the idle and hover preloads in `routePreload.ts`.
 * A chunk that fails to load lands in the nearest error boundary (the center
 * panel's for a route), which offers Try again and Reload.
 *
 * Page fallbacks fill the center panel, so the shell never moves while a page
 * arrives; the spinner inside is delayed, so a fast load shows none.
 */
import { lazyModal, lazyView } from "@/components/ui/lazyView";
import { PanelLoading } from "@/components/ui/LazyFallbacks";

export const SettingsPage = lazyView(
  () => import("../features/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })),
  <PanelLoading label="Loading settings" />,
);

export const DiscoverPage = lazyView(
  () => import("../features/discover/DiscoverPage").then((m) => ({ default: m.DiscoverPage })),
  <PanelLoading label="Loading Discover" />,
);

export const DMView = lazyView(
  () => import("../features/dm/DMView").then((m) => ({ default: m.DMView })),
  <PanelLoading label="Loading messages" />,
);

export const RelayStatusPanel = lazyView(
  () => import("../features/relay/RelayStatusPanel").then((m) => ({ default: m.RelayStatusPanel })),
  <PanelLoading label="Loading relays" />,
);

export const ProfilePage = lazyView(
  () => import("../features/profile/ProfilePage").then((m) => ({ default: m.ProfilePage })),
  <PanelLoading label="Loading profile" />,
);

export const NoteThreadPage = lazyView(
  () => import("../features/profile/NoteThreadPage").then((m) => ({ default: m.NoteThreadPage })),
  <PanelLoading label="Loading note" />,
);

export const ArticlePage = lazyView(
  () => import("../features/longform/ArticlePage").then((m) => ({ default: m.ArticlePage })),
  <PanelLoading label="Loading article" />,
);

export const ArticleEditorPage = lazyView(
  () =>
    import("../features/longform/ArticleEditorPage").then((m) => ({ default: m.ArticleEditorPage })),
  <PanelLoading label="Loading editor" />,
);

/** The music section. Mounted on first open and kept alive (see `MainContent`). */
export const MusicRouter = lazyView(
  () => import("../features/music/MusicRouter").then((m) => ({ default: m.MusicRouter })),
  <PanelLoading label="Loading music" />,
);

export const MusicLinkResolver = lazyView(
  () => import("../features/music/MusicLinkResolver").then((m) => ({ default: m.MusicLinkResolver })),
  <PanelLoading label="Opening music link" />,
);

/** `/invite/:code`. */
export const JoinSpaceModal = lazyModal(
  () => import("../features/spaces/JoinSpaceModal").then((m) => ({ default: m.JoinSpaceModal })),
  "join-space",
);

// Onboarding overlays: shown once to a new account, never to a returning one.
// They draw over the app, so there is no slot to hold while they load.
export const ProfileWizard = lazyView(
  () => import("../features/onboarding/ProfileWizard").then((m) => ({ default: m.ProfileWizard })),
  null,
);

export const AppTour = lazyView(
  () => import("../features/onboarding/AppTour").then((m) => ({ default: m.AppTour })),
  null,
);
