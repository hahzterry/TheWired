import { Suspense, useState, useCallback } from "react";
import { Users, Settings, Search, Lock } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { useSpace } from "./useSpace";
import { useAppDispatch, useAppSelector } from "../../store/hooks";
import { toggleRightPanel } from "../../store/slices/uiSlice";
import { usePermissions } from "./usePermissions";
import { SpaceSettingsModal } from "./lazyModals";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { preloadable, preloadOnIntent } from "@/lib/lazyPreload";
import { parseChannelIdPart } from "./spaceSelectors";
import { selectIsEncryptedSpace } from "../../store/slices/spaceE2eeSlice";
import type { MessageSearchResult } from "../search/useMessageSearch";

// Message search loads when the search button is hovered, focused or pressed.
const loadSearchPanel = preloadable(() =>
  import("../search/SearchPanel").then((m) => ({ default: m.SearchPanel })),
);
const SearchPanel = lazyWithRetry(loadSearchPanel);

export function ChannelHeader() {
  const { activeSpace, activeChannelId, resolveActiveChannel, getActiveChannelType, selectChannel } = useSpace();
  const dispatch = useAppDispatch();
  const currentPubkey = useAppSelector((s) => s.identity.pubkey);
  const allChannels = useAppSelector((s) => s.spaces.channels);
  const encrypted = useAppSelector(selectIsEncryptedSpace(activeSpace?.id));
  const { can } = usePermissions(activeSpace?.id ?? null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const spaceChannels = activeSpace ? allChannels[activeSpace.id] ?? [] : [];

  const handleJumpToMessage = useCallback(
    (result: MessageSearchResult) => {
      if (!result.eventId) return;

      const currentChannelPart = parseChannelIdPart(activeChannelId);

      // Switch channel if the result is in a different one
      if (result.channelId && result.channelId !== currentChannelPart) {
        selectChannel(result.channelId);
        // Wait for channel switch to render, then scroll
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            scrollToEventId(result.eventId!);
          });
        });
      } else {
        scrollToEventId(result.eventId);
      }
    },
    [activeChannelId, selectChannel],
  );

  if (!activeSpace || !activeChannelId) return null;

  const channel = resolveActiveChannel();
  const channelName = channel?.label ?? `#${getActiveChannelType()}`;
  const canManage = can("MANAGE_SPACE") || (!!currentPubkey && activeSpace.adminPubkeys.includes(currentPubkey));

  const searchButton = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setSearchOpen(true)}
      title="Search messages"
      {...preloadOnIntent(loadSearchPanel)}
    >
      <Search size={16} />
    </Button>
  );

  return (
    <div className="flex h-12 shrink-0 items-center border-b border-border px-5">
      <span className="text-[13px] font-semibold text-heading">
        {channelName}
      </span>
      <span className="ml-2 text-xs text-muted">
        in {activeSpace.name}
      </span>
      {encrypted && (
        <span
          className="ml-2 flex items-center gap-1 rounded bg-card px-1.5 py-0.5 text-[10px] text-muted"
          title="Messages here are end-to-end encrypted. The relay stores only ciphertext."
        >
          <Lock size={10} />
          Encrypted
        </span>
      )}
      {channel && channel.slowModeSeconds > 0 && (
        <span className="ml-2 rounded bg-card px-1.5 py-0.5 text-[10px] text-muted">
          Slow mode: {channel.slowModeSeconds}s
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        {searchOpen ? (
          // The button stays in place until the panel has loaded, so the
          // header does not shift.
          <ErrorBoundary variant="inline" scope="panel" label="channel-search" noun="search">
            <Suspense fallback={searchButton}>
              <SearchPanel
                mode="space"
                spaceId={activeSpace.id}
                channels={spaceChannels}
                onClose={() => setSearchOpen(false)}
                onJumpToMessage={handleJumpToMessage}
              />
            </Suspense>
          </ErrorBoundary>
        ) : (
          searchButton
        )}
        {canManage && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSettingsOpen(true)}
            title="Space settings"
          >
            <Settings size={16} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dispatch(toggleRightPanel("space"))}
        >
          <Users size={16} />
        </Button>
      </div>

      {activeSpace && (
        <SpaceSettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          spaceId={activeSpace.id}
        />
      )}
    </div>
  );
}

function scrollToEventId(eventId: string) {
  const el = document.querySelector(`[data-event-id="${eventId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("animate-highlight-flash");
  setTimeout(() => el.classList.remove("animate-highlight-flash"), 1500);
}
