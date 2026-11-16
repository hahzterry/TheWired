import type { NostrEvent } from "../../../types/nostr";
import { EVENT_KINDS } from "../../../types/nostr";
import { indexSpaceFeed, removeEventFromAllSpaceFeeds } from "../../../store/slices/eventsSlice";
import { trackFeedTimestamp } from "../../../store/slices/feedSlice";
import { SPACE_CHANNEL_ROUTES } from "../../../features/spaces/spaceChannelRoutes";
import { hasMediaUrls, hasEmbedUrls } from "../../media/mediaUrlParser";
import type { PipelineContext } from "./types";
import type { Batching } from "./batching";

/**
 * Author-scoped feed indexing: the friends feed and every joined space's
 * notes / media / articles / music channels. Runs after the kind switch in
 * `indexEvent`, for every event.
 *
 * The body is the code as it stood inside `createEventPipeline`.
 */
export function createSpaceFeedIndexer(ctx: PipelineContext, batching: Batching) {
  const { dispatch, getState, authorSetCache } = ctx;
  const { emit } = batching;

  /** Get or create a cached Set from a pubkey array (keyed by cacheKey) */
  function getCachedSet(cacheKey: string, pubkeys: string[]): Set<string> {
    // Cheap fingerprint: length + first + last pubkey
    const fingerprint = `${pubkeys.length}:${pubkeys[0] ?? ""}:${pubkeys[pubkeys.length - 1] ?? ""}`;
    const cached = authorSetCache.get(cacheKey);
    if (cached && cached.fingerprint === fingerprint) {
      return cached.set;
    }
    const set = new Set(pubkeys);
    authorSetCache.set(cacheKey, { set, fingerprint });
    return set;
  }

  // Precompute the set of non-htag kinds for early return in space feed indexing
  const spaceFeedKinds = new Set<number>();
  for (const [, route] of Object.entries(SPACE_CHANNEL_ROUTES)) {
    if (route.filterMode !== "htag") {
      for (const kind of route.kinds) {
        spaceFeedKinds.add(kind);
      }
    }
  }
  // SHORT_TEXT also cross-indexes to media feed
  spaceFeedKinds.add(EVENT_KINDS.SHORT_TEXT);
  // REPOST indexes into the friends feed notes channel only — no real-space
  // route contains kind 6, so the space loop below can never match it.
  spaceFeedKinds.add(EVENT_KINDS.REPOST);

  /** Check if event author is a member of any active space and index accordingly */
  function indexEventIntoSpaceFeeds(event: NostrEvent): void {
    // Early return: skip if event kind doesn't match any non-htag channel route
    if (!spaceFeedKinds.has(event.kind)) return;

    // Chat-scoped polls (h tag) live in the chat timeline, not notes feeds
    if (event.kind === EVENT_KINDS.POLL && event.tags.some((t) => t[0] === "h")) {
      return;
    }

    // Skip private/unlisted music events from space feeds — they should only appear
    // via direct access (library, collaborator views), not in shared space channels
    if (event.kind === EVENT_KINDS.MUSIC_TRACK || event.kind === EVENT_KINDS.MUSIC_ALBUM) {
      const hasPrivateTag = event.tags.some(
        (t) => t[0] === "visibility" && (t[1] === "private" || t[1] === "unlisted"),
      );
      if (hasPrivateTag) return;
      // Audio dropped into a note (`catalog:none`) stays with the note; it reaches
      // a shelf only through an explicit `channel` tag (soot placement parity).
      const offCatalog = event.tags.some((t) => t[0] === "catalog" && t[1] === "none");
      if (offCatalog && !event.tags.some((t) => t[0] === "channel" && t[1])) return;

      // When an addressable event replaces an older version (same pubkey+kind+d_tag),
      // remove the old event ID from all space feeds to prevent stale entries.
      // This happens when visibility changes (e.g., private → space).
      const dTag = event.tags.find((t) => t[0] === "d")?.[1];
      if (dTag) {
        const addrId = `${event.kind}:${event.pubkey}:${dTag}`;
        const existingTrack = getState().music.tracks[addrId] ?? getState().music.albums[addrId.replace("31683:", "33123:")];
        if (existingTrack && existingTrack.eventId !== event.id) {
          dispatch(removeEventFromAllSpaceFeeds(existingTrack.eventId));
        }
      }
    }

    const state = getState();

    // Index into Friends Feed if active and author is in follow list
    if (state.spaces.activeSpaceId === "__friends_feed__") {
      const followList = state.identity.followList;
      if (followList.length > 0) {
        const followSet = getCachedSet("friends_feed", followList);
        // Own posts index too — the Feed composer publishes locally and the
        // subscription includes self in its author filters.
        if (followSet.has(event.pubkey) || event.pubkey === state.identity.pubkey) {
          for (const [channelType, route] of Object.entries(SPACE_CHANNEL_ROUTES)) {
            if (route.filterMode === "htag") continue;
            if (!route.kinds.includes(event.kind)) continue;
            const contextId = `__friends_feed__:${channelType}`;
            emit(indexSpaceFeed({ contextId, eventId: event.id }));
            emit(trackFeedTimestamp({ contextId, createdAt: event.created_at }));
          }
          // Cross-index notes with media into media feed
          if (event.kind === EVENT_KINDS.SHORT_TEXT && (hasMediaUrls(event.content, event) || hasEmbedUrls(event.content))) {
            emit(indexSpaceFeed({ contextId: "__friends_feed__:media", eventId: event.id }));
            emit(trackFeedTimestamp({ contextId: "__friends_feed__:media", createdAt: event.created_at }));
          }
          // Reposts go to the notes channel. Indexed unconditionally (kind 6 also
          // arrives via profile subs) — the showReposts pref gates display in the
          // selector, keeping the toggle reactive without re-indexing.
          if (event.kind === EVENT_KINDS.REPOST) {
            emit(indexSpaceFeed({ contextId: "__friends_feed__:notes", eventId: event.id }));
            emit(trackFeedTimestamp({ contextId: "__friends_feed__:notes", createdAt: event.created_at }));
          }
        }
      }
    }

    const spaces = state.spaces.list;
    if (spaces.length === 0) return;

    const channelsMap = state.spaces.channels;

    for (const space of spaces) {
      // For feed-mode spaces, index events from feed sources only;
      // for community spaces, index events from all members
      const authorPubkeys =
        space.mode === "read" ? space.feedPubkeys : space.memberPubkeys;
      const authorSet = getCachedSet(
        space.mode === "read" ? `feed:${space.id}` : space.id,
        authorPubkeys,
      );
      if (!authorSet.has(event.pubkey)) continue;

      // Space-scoped events (h-tag) should only index into their target spaces.
      // Without this check, a track with ["h", "space-A"] would leak into space-B
      // if the author is a member of both spaces. A multi-space event carries one
      // h tag per space and indexes into each of them.
      const hTags = event.tags.filter((t) => t[0] === "h" && t[1]).map((t) => t[1]);
      if (hTags.length > 0 && !hTags.includes(space.id)) continue;

      // Check which space channel this event kind belongs to
      for (const [channelType, route] of Object.entries(SPACE_CHANNEL_ROUTES)) {
        if (route.filterMode === "htag") continue; // Chat is h-tag scoped, not author-scoped
        if (!route.kinds.includes(event.kind)) continue;

        // Index with channel ID format if channels are loaded.
        // Use filter (not find) to support multiple channels of the same type (e.g. music).
        const spaceChannels = channelsMap[space.id];
        if (spaceChannels && spaceChannels.length > 0) {
          const matchingChannels = spaceChannels.filter((c) => c.type === channelType);
          const eventChannelTag = event.tags.find((t) => t[0] === "channel")?.[1];

          for (const ch of matchingChannels) {
            if (eventChannelTag) {
              // Event explicitly targets a specific channel — only index into that channel,
              // regardless of feed mode. A track tagged for #content should NOT also appear in #music.
              if (eventChannelTag !== ch.id) continue;
            } else if (ch.feedMode === "curated") {
              // Curated channels only accept explicitly tagged events
              continue;
            }
            // All-mode channels with no channel tag on the event: accept (default behavior)
            const contextId = `${space.id}:${ch.id}`;
            emit(indexSpaceFeed({ contextId, eventId: event.id }));
            emit(trackFeedTimestamp({ contextId, createdAt: event.created_at }));
          }
        }

        // Also index with legacy type-based format for selectors that use it
        const legacyContextId = `${space.id}:${channelType}`;
        emit(indexSpaceFeed({ contextId: legacyContextId, eventId: event.id }));
        emit(trackFeedTimestamp({ contextId: legacyContextId, createdAt: event.created_at }));
      }

      // Cross-index: kind:1 notes that contain media URLs or embed links also go into the media feed
      if (event.kind === EVENT_KINDS.SHORT_TEXT && (hasMediaUrls(event.content, event) || hasEmbedUrls(event.content))) {
        const spaceChannels = channelsMap[space.id];
        const mediaChannel = spaceChannels?.find((c) => c.type === "media");
        if (mediaChannel) {
          const contextId = `${space.id}:${mediaChannel.id}`;
          emit(indexSpaceFeed({ contextId, eventId: event.id }));
          emit(trackFeedTimestamp({ contextId, createdAt: event.created_at }));
        }
        // Also legacy format
        const legacyMediaContextId = `${space.id}:media`;
        emit(indexSpaceFeed({ contextId: legacyMediaContextId, eventId: event.id }));
        emit(trackFeedTimestamp({ contextId: legacyMediaContextId, createdAt: event.created_at }));
      }
    }
  }

  return { indexEventIntoSpaceFeeds };
}
