import { useState, useMemo, useEffect, useCallback, useRef, memo } from "react";
import { ChevronDown, ChevronUp, ImageIcon, Film } from "lucide-react";
import { useAppSelector } from "../../store/hooks";
import { usePlaybackBarSpacing } from "../../hooks/usePlaybackBarSpacing";
import { selectSpaceRootNotes, selectSpaceRootNoteIds, selectActiveSpace } from "./spaceSelectors";
import { Avatar } from "../../components/ui/Avatar";
import { RichContent } from "../../components/content/RichContent";
import { useProfile } from "../profile/useProfile";
import { useUserPopover } from "../profile/UserPopoverContext";
import { useMusicNote } from "../../lib/media/useNoteMedia";
import { imageCache } from "../../lib/cache/imageCache";
import { useAnchoredScrollRestore } from "../../hooks/useAnchoredScrollRestore";
import { readFeedScroll, writeFeedScroll } from "../../hooks/feedScrollMemory";
import { useRetainedState } from "../../hooks/useRetainedState";
import { useFeedPagination } from "./useFeedPagination";
import { FeedToolbar } from "./FeedToolbar";
import { LoadMoreButton } from "./LoadMoreButton";
import { VirtualFeed, type VirtualFeedHandle, type VirtualFeedRange } from "../../components/virtual/VirtualFeed";
import { useEngagementRange } from "../profile/engagementCollector";
import { parseQuoteRef } from "./noteParser";
import { useIsBlocked } from "../../hooks/useIsBlocked";
import { useUnblock } from "../../hooks/useUnblock";
import { FRIENDS_FEED_ID } from "../friends/friendsFeedConstants";
import { BlockedMessage } from "../../components/ui/BlockedMessage";
import { QuotedNote } from "./notes/QuotedNote";
import { NoteFooter } from "./notes/NoteFooter";
import type { NostrEvent } from "../../types/nostr";
import { EVENT_KINDS } from "../../types/nostr";
import { MusicEmbedCard } from "../../components/content/MusicEmbedCard";
import { MusicPostMedia } from "../../components/content/MusicPostMedia";
import { RepostHeader } from "../profile/RepostHeader";
import { useRepostedEvent } from "../profile/useRepostedEvent";
import { NoteComposer } from "../profile/NoteComposer";
import { PollNoteCard } from "../polls/PollNoteCard";
import {
  selectFriendsFeedNotes,
  selectFriendsFeedNoteIds,
  selectMutedPubkeySet,
  selectMutedWordList,
} from "../friends/friendsFeedSelectors";
import { selectHiddenPubkeySet } from "../../store/slices/feedPrefsSlice";
import { isEventVisibleInFeed } from "../friends/feedVisibility";
import { FeedPrefsButton } from "../friends/FeedPrefsButton";
import { ItemBoundary } from "@/components/ui/ErrorBoundary";

/** Height guess for a note card that was never measured (text + footer). */
const NOTE_HEIGHT_ESTIMATE = 220;
/** Space between cards (the old `space-y-4`). */
const NOTE_GAP = 16;
/** Cards that fade in on first paint. */
const INTRO_CARDS = 15;

const noteKey = (event: NostrEvent) => event.id;

const NoteCard = memo(function NoteCard({ event }: { event: NostrEvent }) {
  const { profile } = useProfile(event.pubkey);
  const isBlocked = useIsBlocked(event.pubkey);
  const { openUserPopover } = useUserPopover();
  // Kept while the card is outside the feed's rendered window.
  const [showMedia, setShowMedia] = useRetainedState(`note:${event.id}:media`, true);
  const avatarRef = useRef<HTMLButtonElement>(null);

  const quoteRef = useMemo(() => parseQuoteRef(event), [event]);

  const name =
    profile?.display_name || profile?.name || event.pubkey.slice(0, 8) + "...";
  const date = new Date(event.created_at * 1000);
  const timeStr = date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  const { text: cleanText, media, musicRefs } = useMusicNote(event);

  useEffect(() => {
    const imageUrls = media
      .filter((m) => m.type === "image")
      .map((m) => m.url);
    if (imageUrls.length > 0) {
      imageCache.preloadMany(imageUrls);
    }
  }, [media]);

  const imageCount = media.filter((m) => m.type === "image").length;
  const videoCount = media.filter((m) => m.type === "video").length;

  const unblock = useUnblock(event.pubkey);

  if (isBlocked) {
    return <BlockedMessage variant="note" onUnblock={unblock}><div /></BlockedMessage>;
  }

  return (
    <div className="rounded-lg border-primary-glow bg-card p-4 hover-lift transition-all duration-150 hover:glow-primary">
      <div className="mb-2 flex items-center gap-2">
        <button
          ref={avatarRef}
          type="button"
          onClick={() => {
            if (avatarRef.current) openUserPopover(event.pubkey, avatarRef.current);
          }}
          className="cursor-pointer"
        >
          <Avatar src={profile?.picture} alt={name} size="sm" />
        </button>
        <span className="text-sm font-medium text-heading">{name}</span>
        <span className="text-xs text-muted">{timeStr}</span>
      </div>

      {cleanText && (
        <div className="text-sm leading-relaxed text-body">
          <RichContent
            content={cleanText}
            event={event}
            onMentionClick={openUserPopover}
            suppressEventIds={quoteRef ? [quoteRef.eventId] : undefined}
          />
        </div>
      )}

      {quoteRef && (
        <QuotedNote eventId={quoteRef.eventId} relayHint={quoteRef.relayHint} pubkey={quoteRef.pubkey} />
      )}

      {media.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowMedia((v) => !v)}
            className="flex items-center gap-1.5 rounded-md bg-card-hover/60 px-2.5 py-1 text-xs text-soft transition-colors hover:bg-card-hover hover:text-heading"
          >
            {showMedia ? (
              <ChevronUp size={13} />
            ) : (
              <ChevronDown size={13} />
            )}
            {imageCount > 0 && (
              <span className="flex items-center gap-0.5">
                <ImageIcon size={12} /> {imageCount}
              </span>
            )}
            {videoCount > 0 && (
              <span className="flex items-center gap-0.5">
                <Film size={12} /> {videoCount}
              </span>
            )}
            <span>{showMedia ? "Hide media" : "Show media"}</span>
          </button>
        </div>
      )}

      {/* Media + the post's music (a track on its picture, or rows). Hiding
          media keeps it mounted, and keeps the music as rows. */}
      {(media.length > 0 || musicRefs.length > 0) && (
        <MusicPostMedia media={media} refs={musicRefs} mediaHidden={!showMedia} />
      )}

      {/* Engagement counts, actions, replies, thread, share — isolated in a
          memoized subtree so the kind 7/6/1 event-storm (and interaction
          toggles) never re-render the text or media above. */}
      <NoteFooter event={event} />
    </div>
  );
});

/** Repost (kind:6) card: "Reposted by" header + the original note, resolved
 *  via useRepostedEvent (embedded JSON is schnorr-verified by the pipeline —
 *  never rendered directly). */
const RepostCard = memo(function RepostCard({ event }: { event: NostrEvent }) {
  const original = useRepostedEvent(event);
  const muted = useAppSelector(selectMutedPubkeySet);
  const hidden = useAppSelector(selectHiddenPubkeySet);
  const words = useAppSelector(selectMutedWordList);

  if (!original) {
    return (
      <div className="rounded-lg border-primary-glow bg-card p-4">
        <RepostHeader pubkey={event.pubkey} />
        <p className="text-sm text-muted">Loading reposted note...</p>
      </div>
    );
  }

  // The feed selector vets the reposter; the original resolves async, so its
  // author/content gets the same mute/hidden/word check here.
  if (!isEventVisibleInFeed(original, muted, hidden, words)) return null;

  if (
    original.kind === EVENT_KINDS.MUSIC_TRACK ||
    original.kind === EVENT_KINDS.MUSIC_ALBUM ||
    original.kind === EVENT_KINDS.MUSIC_PLAYLIST
  ) {
    const dTag = original.tags.find((t) => t[0] === "d")?.[1] ?? "";
    return (
      <div>
        <RepostHeader pubkey={event.pubkey} />
        <div className="rounded-lg border-primary-glow bg-card p-4">
          <MusicEmbedCard
            kind={original.kind}
            pubkey={original.pubkey}
            identifier={dTag}
          />
        </div>
      </div>
    );
  }

  if (original.kind === EVENT_KINDS.POLL) {
    return (
      <div>
        <RepostHeader pubkey={event.pubkey} />
        <PollNoteCard event={original} />
      </div>
    );
  }

  return (
    <div>
      <RepostHeader pubkey={event.pubkey} />
      <NoteCard event={original} />
    </div>
  );
});

export function NotesFeed() {
  const activeChannelId = useAppSelector((s) => s.spaces.activeChannelId);
  const activeSpaceId = useAppSelector((s) => s.spaces.activeSpaceId);
  const activeSpace = useAppSelector(selectActiveSpace);
  const isFriendsFeed = activeSpaceId === FRIENDS_FEED_ID;
  // The Feed gets mute/hidden/word filtering + reply/repost prefs; spaces keep
  // the plain root-notes selectors. Selector identity only flips on space
  // switch, so the conditional is safe for memoization.
  const notes = useAppSelector(
    isFriendsFeed ? selectFriendsFeedNotes : selectSpaceRootNotes,
  );
  const noteIds = useAppSelector(
    isFriendsFeed ? selectFriendsFeedNoteIds : selectSpaceRootNoteIds,
  );
  const { meta, refresh, loadMore } = useFeedPagination("notes");
  const { scrollPaddingClass } = usePlaybackBarSpacing();

  // The feed is virtualized: only the cards around the viewport are mounted,
  // each still carrying its own profile sub, media and engagement subtree.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const feedRef = useRef<VirtualFeedHandle>(null);

  // Leaving and coming back lands on the same card. The card is the anchor
  // (not a pixel offset): cards outside the window are not measured, so pixel
  // positions mean nothing until the list has rendered there.
  const { containerRef } = useAnchoredScrollRestore({
    key: activeChannelId,
    read: () => readFeedScroll(activeChannelId),
    write: (pos) => writeFeedScroll(activeChannelId, pos),
    cardAttr: "data-feed-anchor",
    scrollToAnchor: (id, offset) => feedRef.current?.scrollToKey(id, offset) ?? false,
  });
  const attachScroller = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef(node);
      setScrollEl(node);
    },
    [containerRef],
  );
  const savedPosition = readFeedScroll(activeChannelId);

  // For Friends Feed and read-only spaces, replies/reactions live on repliers' own relays,
  // not a single host relay — use all read relays (undefined).
  const engagementRelays = useMemo(
    () =>
      isFriendsFeed || activeSpace?.mode === "read"
        ? undefined
        : activeSpace?.hostRelay
          ? [activeSpace.hostRelay]
          : undefined,
    [isFriendsFeed, activeSpace?.mode, activeSpace?.hostRelay],
  );

  // Engagement follows the rendered range: each note is fetched once, the
  // first time it comes into the window, however far down the feed it is.
  const reportVisible = useEngagementRange(engagementRelays, activeChannelId ?? "");
  const noteIdsRef = useRef(noteIds);
  noteIdsRef.current = noteIds;
  const handleRange = useCallback(
    ({ startIndex, endIndex }: VirtualFeedRange) => {
      reportVisible(noteIdsRef.current.slice(startIndex, endIndex + 1), startIndex);
    },
    [reportVisible],
  );

  const renderNote = useCallback(
    (event: NostrEvent, index: number, intro: boolean) => {
      const animate = intro && index < INTRO_CARDS;
      return (
        <div
          data-feed-anchor={event.id}
          className={animate ? "animate-fade-in-up" : undefined}
          style={animate ? { animationDelay: `${index * 50}ms` } : undefined}
        >
          <ItemBoundary id={event.id} label="note" noun="note">
            {event.kind === EVENT_KINDS.REPOST ? (
              <RepostCard event={event} />
            ) : event.kind === EVENT_KINDS.POLL ? (
              <PollNoteCard event={event} />
            ) : (
              <NoteCard event={event} />
            )}
          </ItemBoundary>
        </div>
      );
    },
    [],
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <FeedToolbar
        isRefreshing={meta.isRefreshing}
        onRefresh={refresh}
        rightSlot={isFriendsFeed ? <FeedPrefsButton channelType="notes" /> : undefined}
      />
      <div ref={attachScroller} className={`flex-1 overflow-y-auto p-5 ${scrollPaddingClass}`}>
        {isFriendsFeed && <NoteComposer className="mb-4 w-full" />}
        {notes.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted">
              {isFriendsFeed
                ? "No notes yet from people you follow"
                : activeSpace?.mode === "read"
                  ? "No notes yet -- add feed sources to see content here"
                  : "No notes yet from space members"}
            </p>
          </div>
        ) : (
          <>
            <VirtualFeed
              handleRef={feedRef}
              items={notes}
              itemKey={noteKey}
              renderItem={renderNote}
              scrollParent={scrollEl}
              listKey={activeChannelId ?? "notes"}
              heightScope="notes"
              estimatedItemHeight={NOTE_HEIGHT_ESTIMATE}
              gap={NOTE_GAP}
              initialAnchor={
                savedPosition?.anchorId
                  ? { key: savedPosition.anchorId, offset: savedPosition.anchorOffset ?? 0 }
                  : null
              }
              onRangeChange={handleRange}
            />
            {/* Everything fetched is in the list; older notes come from the relay. */}
            <div className="mt-4">
              <LoadMoreButton
                isLoading={meta.isLoadingMore}
                hasMore={meta.hasMore}
                onLoadMore={loadMore}
                error={meta.loadMoreError}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
