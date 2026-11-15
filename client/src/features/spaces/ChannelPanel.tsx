import { useRef } from "react";
import { useAppSelector } from "../../store/hooks";
import { parseChannelIdPart } from "./spaceSelectors";
import { ChatView } from "../chat/ChatView";
import { NotesFeed } from "./NotesFeed";
import { MediaFeed } from "./MediaFeed";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { lazyView } from "@/components/ui/lazyView";
import { PanelLoading } from "@/components/ui/LazyFallbacks";
import { livekitPreload } from "@/lib/webrtc/livekit";

// Chat, notes and media are what a space opens on, so they ship with the
// shell. The other channel types load the first time one is opened.
const ReelsView = lazyView(
  () => import("../media/ReelsView").then((m) => ({ default: m.ReelsView })),
  <PanelLoading label="Loading reels" />,
);
const LongFormView = lazyView(
  () => import("../longform/LongFormView").then((m) => ({ default: m.LongFormView })),
  <PanelLoading label="Loading articles" />,
);
const SpaceMusicView = lazyView(
  () => import("../music/SpaceMusicView").then((m) => ({ default: m.SpaceMusicView })),
  <PanelLoading label="Loading music" />,
);
const VoiceChannel = lazyView(
  () =>
    import("../voice/VoiceChannel").then((m) => {
      // Someone looking at a voice channel is about to join it.
      livekitPreload.preload();
      return { default: m.VoiceChannel };
    }),
  <PanelLoading label="Loading voice channel" />,
);

/**
 * Keep-alive channel panel.
 *
 * Instead of conditional rendering (which destroys & recreates DOM on every
 * channel switch), this component mounts all visited channel views and uses
 * CSS `display: none` to hide inactive ones. This means:
 *
 * - DOM elements (including decoded images) survive channel switches
 * - Scroll positions are preserved natively
 * - Component state (expanded items, filter tabs, etc.) persists
 * - No image re-decode flash when switching back to a channel
 *
 * Views are lazily activated: a channel view only mounts after the user visits
 * it for the first time, keeping initial render lightweight.
 */

const CHANNEL_COMPONENTS: Record<string, React.ComponentType> = {
  chat: ChatView,
  notes: NotesFeed,
  media: MediaFeed,
  articles: LongFormView,
  reels: ReelsView,
  "long-form": LongFormView,
  music: SpaceMusicView,
  voice: VoiceChannel,
  video: VoiceChannel,
};

const EMPTY_CHANNELS: never[] = [];

export function ChannelPanel() {
  const activeChannelId = useAppSelector((s) => s.spaces.activeChannelId);
  const activeSpaceId = useAppSelector((s) => s.spaces.activeSpaceId);
  const channels = useAppSelector(
    (s) => (activeSpaceId ? s.spaces.channels[activeSpaceId] : undefined) ?? EMPTY_CHANNELS,
  );

  // Resolve channel type from channel ID
  const channelIdPart = parseChannelIdPart(activeChannelId);
  const channel = channels.find((c) => c.id === channelIdPart);
  const channelType = channel?.type ?? channelIdPart; // Legacy fallback

  // Track which channels have been visited so we can lazily mount them
  const visitedRef = useRef(new Set<string>());
  if (channelType) {
    visitedRef.current.add(channelType);
  }

  return (
    <>
      {[...visitedRef.current].map((type) => {
        const Component = CHANNEL_COMPONENTS[type];
        if (!Component) return null;

        const isActive = type === channelType;

        return (
          <div
            key={type}
            className={isActive ? "flex flex-1 overflow-hidden" : "hidden"}
          >
            {/* One boundary per channel type: a view that throws, or whose
                chunk fails to load, leaves the other channels usable. */}
            <ErrorBoundary variant="panel" label="channel-view">
              <Component />
            </ErrorBoundary>
          </div>
        );
      })}
    </>
  );
}
