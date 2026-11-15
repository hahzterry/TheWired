import { useState } from "react";
import { Sidebar } from "../components/layout/Sidebar";
import { CenterPanel } from "../components/layout/CenterPanel";
import { RightPanel } from "../components/layout/RightPanel";
import { TopBar } from "../components/layout/TopBar";
import { ThemeBackground } from "../components/layout/ThemeBackground";
import { FloatingPlaybackBar } from "../features/music/playbackBar/FloatingPlaybackBar";
import { UserPopoverProvider } from "../features/profile/UserPopoverContext";
import { NotificationToastStack } from "../features/notifications/NotificationToast";
import { WalletProvider } from "../features/wallet/WalletProvider";
import { AIProvider } from "../features/ai/AIProvider";
import { CallController } from "../features/calling/CallController";
import { IncomingCallBanner } from "../features/calling/IncomingCallBanner";
import { CallNotice } from "../features/calling/CallNotice";
import { useAppSelector } from "../store/hooks";
import { useExternalLinkHandler } from "../hooks/useExternalLinkHandler";
import { useCallShortcuts } from "../hooks/useCallShortcuts";
import { ScreenSharePill } from "../features/voice/ScreenSharePill";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";
import { ActiveCallFallback, IncomingCallFallback } from "../features/calling/CallOverlayFallback";

export function Layout() {
  useExternalLinkHandler();
  useCallShortcuts();
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const hasTrack = useAppSelector((s) => !!s.music?.player.currentTrackId);
  const hasActiveCall = useAppSelector((s) => !!s.call.activeCall);
  const hasIncomingCall = useAppSelector((s) => !!s.call.incomingCall);
  const hasCallNotice = useAppSelector((s) => !!s.call.notice);

  return (
    <WalletProvider>
      <UserPopoverProvider>
      <AIProvider />
      <ThemeBackground />
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        <TopBar
          sidebarExpanded={sidebarExpanded}
          onToggleSidebar={() => setSidebarExpanded((v) => !v)}
        />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar expanded={sidebarExpanded} />
          <CenterPanel />
          <RightPanel />
        </div>
        {/* Overlays sit outside the panels, so each gets its own boundary:
            a broken toast or player bar must not take the shell down. */}
        {hasTrack && (
          <ErrorBoundary variant="inline" scope="overlay" label="playback-bar" noun="player">
            <FloatingPlaybackBar />
          </ErrorBoundary>
        )}
        {/* A call outlives its UI: the fallbacks keep End call / Decline. */}
        {hasActiveCall && (
          <ErrorBoundary
            variant="inline"
            scope="overlay"
            label="call"
            fallback={({ retry }) => <ActiveCallFallback onRetry={retry} />}
          >
            <CallController />
          </ErrorBoundary>
        )}
        {hasIncomingCall && (
          <ErrorBoundary
            variant="inline"
            scope="overlay"
            label="incoming-call"
            fallback={({ retry }) => <IncomingCallFallback onRetry={retry} />}
          >
            <IncomingCallBanner />
          </ErrorBoundary>
        )}
        {hasCallNotice && !hasIncomingCall && (
          <ErrorBoundary variant="inline" scope="overlay" label="call-notice" fallback={null}>
            <CallNotice />
          </ErrorBoundary>
        )}
        <ErrorBoundary variant="inline" scope="overlay" label="screen-share" fallback={null}>
          <ScreenSharePill />
        </ErrorBoundary>
        <ErrorBoundary variant="inline" scope="overlay" label="toasts" fallback={null}>
          <NotificationToastStack />
        </ErrorBoundary>
      </div>
      </UserPopoverProvider>
    </WalletProvider>
  );
}
