import { useEffect, useState, Suspense } from "react";
import { BrowserRouter, Routes, Route, Outlet, useParams, useNavigate } from "react-router-dom";
import { BrainCircuit } from "lucide-react";
import { Layout } from "./Layout";
import { useAppSelector } from "../store/hooks";
import { LoginScreen } from "../features/identity/LoginScreen";
import { SpaceView } from "../features/spaces/SpaceView";
import { ChannelPanel } from "../features/spaces/ChannelPanel";
// Every route and overlay below the shell is a lazy chunk (with its Suspense
// fallback built in); only the landing view is part of the startup bundle.
import {
  AppTour,
  ArticleEditorPage,
  ArticlePage,
  DiscoverPage,
  DMView,
  JoinSpaceModal,
  MusicLinkResolver,
  MusicRouter,
  NoteThreadPage,
  ProfilePage,
  ProfileWizard,
  RelayStatusPanel,
  SettingsPage,
} from "./lazyRoutes";
import { FriendsFeedPanel } from "../features/friends/FriendsFeedPanel";
import { FRIENDS_FEED_ID } from "../features/friends/friendsFeedConstants";
import { ThemeProvider } from "../contexts/ThemeContext";
import { tryRestoreSession } from "../lib/nostr/loginFlow";
import { UpdateOverlay } from "../components/UpdateOverlay";
import { ZoomIndicator } from "../components/ZoomIndicator";
import { NavigationLogger } from "../lib/debug/NavigationLogger";
import { getAutoUpdatesEnabled } from "../features/settings/appSettingsStore";
import { useAppUpdater } from "../hooks/useAppUpdater";
import { useZoomShortcuts } from "../hooks/useZoomShortcuts";
import { useEmbeddedRelayAutostart } from "../features/settings/useEmbeddedRelayAutostart";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";
import { BoundaryResetProvider } from "./BoundaryResetProvider";
import { lazyWithRetry } from "../lib/lazyWithRetry";

// Lazy: the AI chat tree (react-markdown / rehype-highlight / marked) only loads
// the first time the user opens the AI tab, then stays mounted (keep-alive).
const AIChatView = lazyWithRetry(() =>
  import("../features/ai/AIChatView").then((m) => ({ default: m.AIChatView })),
);

/** Restores session + guards all routes behind login */
function AuthGate() {
  const isLoggedIn = useAppSelector((s) => !!s.identity.pubkey);
  const switchingAccount = useAppSelector((s) => s.identity.switchingAccount);
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    tryRestoreSession().finally(() => setRestoring(false));
  }, []);

  // Desktop: bring the self-hosted relay back up (if the user was hosting) and
  // re-point their self-hosted spaces to its live address after a restart.
  useEmbeddedRelayAutostart();

  if (restoring || switchingAccount) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-background">
        <img
          src="/logo.png"
          alt="The Wired"
          width={80}
          height={80}
          className="rounded-2xl animate-pulse"
        />
        <p className="mt-6 text-sm font-medium text-muted tracking-wide">
          Starting...
        </p>
      </div>
    );
  }

  if (!isLoggedIn) {
    return <LoginScreen />;
  }

  return (
    <>
      <Outlet />
      <OnboardingOverlays />
    </>
  );
}

/** Renders profile wizard and app tour overlays when active */
function OnboardingOverlays() {
  const showProfileWizard = useAppSelector((s) => s.onboarding.showProfileWizard);
  const showAppTour = useAppSelector((s) => s.onboarding.showAppTour);

  return (
    <>
      {/* Onboarding is optional chrome: if it throws, drop it and keep the app. */}
      {showProfileWizard && (
        <ErrorBoundary variant="inline" scope="overlay" label="profile-wizard" fallback={null}>
          <ProfileWizard />
        </ErrorBoundary>
      )}
      {showAppTour && (
        <ErrorBoundary variant="inline" scope="overlay" label="app-tour" fallback={null}>
          <AppTour />
        </ErrorBoundary>
      )}
    </>
  );
}

function AILoadingFallback() {
  return (
    <div className="flex flex-1 items-center justify-center bg-background">
      <BrainCircuit size={28} className="animate-pulse text-primary/60" />
    </div>
  );
}

function MainContent() {
  const activeChannelId = useAppSelector((s) => s.spaces.activeChannelId);
  const activeSpaceId = useAppSelector((s) => s.spaces.activeSpaceId);
  const sidebarMode = useAppSelector((s) => s.ui.sidebarMode);
  const isMusic = sidebarMode === "music";
  const isAI = sidebarMode === "ai";
  const isFriendsFeed = activeSpaceId === FRIENDS_FEED_ID;

  // Mount the (lazy) AI view only after the tab is first opened, then keep it
  // mounted so streaming survives a sidebar switch — this is what lets the AI
  // chunk stay out of the initial load for users who never open it.
  const [aiEverOpened, setAiEverOpened] = useState(false);
  useEffect(() => {
    if (isAI) setAiEverOpened(true);
  }, [isAI]);
  // Same for music: its chunk loads on first open, and the view then stays
  // mounted so scroll positions and view state survive a sidebar switch.
  // (Playback itself lives outside this tree and is unaffected either way.)
  const [musicEverOpened, setMusicEverOpened] = useState(isMusic);
  if (isMusic && !musicEverOpened) setMusicEverOpened(true);

  return (
    <>
      {/* Music view — kept alive once opened so it doesn't restart on sidebar switch */}
      {musicEverOpened && (
        <div className={isMusic ? "flex flex-1 flex-col overflow-hidden" : "hidden"}>
          <ErrorBoundary variant="panel" label="music-view">
            <MusicRouter />
          </ErrorBoundary>
        </div>
      )}

      {/* AI view — kept alive so streaming survives a sidebar switch */}
      {aiEverOpened && (
        <div className={isAI ? "flex flex-1 flex-col overflow-hidden" : "hidden"}>
          <ErrorBoundary variant="panel" label="ai-view">
            <Suspense fallback={<AILoadingFallback />}>
              <AIChatView />
            </Suspense>
          </ErrorBoundary>
        </div>
      )}

      {/* Spaces view */}
      <div className={isMusic || isAI ? "hidden" : "flex flex-1 flex-col overflow-hidden"}>
        <ErrorBoundary variant="panel" label="spaces-view">
        {isFriendsFeed ? (
          <FriendsFeedPanel />
        ) : !activeChannelId ? (
          <SpaceView>
            <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-grid">
              <div className="pointer-events-none absolute inset-0 bg-ambient opacity-60" />
              <div className="relative z-10 text-center">
                <h2 className="text-2xl font-bold text-silver-gradient tracking-wide">
                  Welcome to The Wired
                </h2>
                <p className="mt-2 text-sm text-soft">
                  Select a space from the sidebar to get started
                </p>
              </div>
            </div>
          </SpaceView>
        ) : (
          <SpaceView>
            <ChannelPanel />
          </SpaceView>
        )}
        </ErrorBoundary>
      </div>
    </>
  );
}

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const shouldAutoUpdate = isTauri && getAutoUpdatesEnabled();

/** Silently checks for updates on startup; shows overlay only when an update is found */
function AutoUpdateGate({ children }: { children: React.ReactNode }) {
  const { status, version, progress, error } = useAppUpdater(true, true);
  const [dismissed, setDismissed] = useState(false);

  const showOverlay =
    !dismissed &&
    (status === "available" ||
      status === "downloading" ||
      status === "ready");

  if (showOverlay) {
    return (
      <UpdateOverlay
        status={status}
        version={version}
        progress={progress}
        error={error}
        onSkip={() => setDismissed(true)}
      />
    );
  }

  // Error — don't block the app, just let it through
  return <>{children}</>;
}

export default function App() {
  useZoomShortcuts();
  return (
    <ThemeProvider>
      <BrowserRouter>
        <NavigationLogger />
        <BoundaryResetProvider>
          {/* Route level: catches the auth gate, the login screen and the
              shell itself. Panels and items inside the shell have their own. */}
          <ErrorBoundary variant="screen" label="routes">
            {shouldAutoUpdate ? (
              <AutoUpdateGate>
                <AppRoutes />
              </AutoUpdateGate>
            ) : (
              <AppRoutes />
            )}
          </ErrorBoundary>
        </BoundaryResetProvider>
        <ZoomIndicator />
      </BrowserRouter>
    </ThemeProvider>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route element={<AuthGate />}>
        <Route element={<Layout />}>
          <Route index element={<MainContent />} />
          <Route path="relays" element={<RelayStatusPanel />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="discover" element={<DiscoverPage />} />
          <Route path="dm" element={<DMView />} />
          <Route path="dm/:pubkey" element={<DMView />} />
          <Route path="music/album/:pubkey/:slug" element={<MusicLinkResolver type="album" />} />
          <Route path="music/track/:pubkey/:slug" element={<MusicLinkResolver type="track" />} />
          <Route path="music/playlist/:pubkey/:slug" element={<MusicLinkResolver type="playlist" />} />
          <Route path="write" element={<ArticleEditorPage />} />
          <Route path="write/:naddr" element={<ArticleEditorPage />} />
          <Route path="article/:id" element={<ArticlePage />} />
          <Route
            path="note/:noteId"
            element={<NoteRouteWrapper />}
          />
          <Route
            path="profile/:pubkey"
            element={<ProfileRouteWrapper />}
          />
          <Route
            path="invite/:code"
            element={<InviteRouteWrapper />}
          />
        </Route>
      </Route>
    </Routes>
  );
}

function NoteRouteWrapper() {
  const { noteId } = useParams<{ noteId: string }>();
  if (!noteId) return null;
  return <NoteThreadPage noteId={noteId} />;
}

function ProfileRouteWrapper() {
  const { pubkey } = useParams<{ pubkey: string }>();
  if (!pubkey) return null;
  return <ProfilePage pubkey={pubkey} />;
}

function InviteRouteWrapper() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  if (!code) return null;
  return (
    <>
      <MainContent />
      <JoinSpaceModal
        open
        onClose={() => navigate("/")}
        initialCode={code}
      />
    </>
  );
}
