import { store } from "../../../store";
import { subscriptionManager } from "../subscriptionManager";
import { EVENT_KINDS } from "../../../types/nostr";
import { loadMusicLibraryWithTime, loadMusicFolders, type MusicFoldersRow, type MusicLibraryState } from "../../db/musicStore";
import { parseFolderDocs, parseLibraryRecord } from "@ishtarservices/core";
import { fetchMissingLibraryItems } from "../../../features/music/libraryFill";
import { syncSavedVersions, watchSavedItemsForUpdates } from "../../../features/music/savedVersionSync";
import { getEventsByKind } from "../../db/eventStore";
import { trackPendingDeletion, restoreDeletedAddrIds } from "../../../store/slices/eventsSlice";
import {
  addTracks,
  addAlbums,
  addPlaylists,
  addAnnotation,
  indexTrackByArtist,
  indexTrackByAlbum,
  indexTrackByArtistName,
  indexAlbumByArtist,
  indexAlbumByArtistName,
  musicLibraryHydrated,
  recordMovedRelease,
} from "../../../store/slices/musicSlice";
import { parseTrackEvent, parsePrivateTrackEvent } from "../../../features/music/trackParser";
import { parseAlbumEvent, parsePrivateAlbumEvent } from "../../../features/music/albumParser";
import { parsePlaylistEvent } from "../../../features/music/playlistParser";
import { parseAnnotationEvent } from "../../../features/music/annotationParser";
import { PROFILE_RELAYS } from "../constants";
import { hydrateHeldProjectKeys, onProjectKeyAdded, retireMovedProjectKeys } from "../../../features/music/sharedKey/projectKeys";
import { addressOf, movedTargetOf } from "../../../features/music/sharedKey/members";
import { loginState } from "./state";

// Music at login: releases, playlists, annotations and the library from
// IndexedDB, then the music subscriptions.

/** performLogin steps 7c + 7d: music events and the music library, from IndexedDB. */
export async function hydrateMusicFromCache(pubkey: string): Promise<void> {
  // Step 7c: Load music events from IndexedDB, filtering out any that have
  // been deleted (kind:5 events referencing them via "a" tags)
  const [trackEvents, albumEvents, playlistEvents, annotationEvents, deletionEvents] = await Promise.all([
    getEventsByKind(EVENT_KINDS.MUSIC_TRACK, 500),
    getEventsByKind(EVENT_KINDS.MUSIC_ALBUM, 200),
    getEventsByKind(EVENT_KINDS.MUSIC_PLAYLIST, 200),
    getEventsByKind(EVENT_KINDS.MUSIC_TRACK_NOTES, 500),
    getEventsByKind(EVENT_KINDS.DELETION, 500),
  ]);

  // Build deletion lookups from persisted deletion events.
  // For addressable IDs ("a" tags), track the deletion timestamp so that
  // re-published events (created AFTER the deletion) are NOT filtered out.
  const deletedAddrTimestamps = new Map<string, number>(); // addr → latest deletion created_at
  // e-tag deletions, keyed by target event id → the pubkeys that requested them.
  // We can't know the target's author here (notes aren't loaded from IDB at this
  // point), so these are seeded as PENDING and resolved with an author check when
  // the target arrives over the wire (#21) — never as a blanket suppression.
  const eDeletions = new Map<string, Set<string>>();
  for (const delEvt of deletionEvents) {
    for (const tag of delEvt.tags) {
      if (tag[0] === "a" && tag[1]) {
        // Only honor deletions from the content author
        const addrPubkey = tag[1].split(":")[1];
        if (addrPubkey === delEvt.pubkey) {
          const prev = deletedAddrTimestamps.get(tag[1]) ?? 0;
          deletedAddrTimestamps.set(tag[1], Math.max(prev, delEvt.created_at));
        }
      }
      if (tag[0] === "e" && tag[1]) {
        (eDeletions.get(tag[1]) ?? eDeletions.set(tag[1], new Set()).get(tag[1])!).add(delEvt.pubkey);
      }
    }
  }
  /** An IDB-loaded event is e-tag-deleted only if one of its deleters is its own author. */
  const isEDeletedByAuthor = (e: { id: string; pubkey: string }): boolean =>
    eDeletions.get(e.id)?.has(e.pubkey) ?? false;

  /** Check if an event is superseded by a deletion (only for events created before the deletion) */
  function isDeletedByAddr(event: { pubkey: string; created_at: number; tags: string[][] }, kindNum: number): boolean {
    const dTag = event.tags.find((t) => t[0] === "d")?.[1];
    if (dTag === undefined) return false;
    const addr = `${kindNum}:${event.pubkey}:${dTag}`;
    const deletedAt = deletedAddrTimestamps.get(addr);
    // Only filter if the event was created BEFORE or AT the deletion time.
    // Events re-published AFTER a deletion supersede it.
    return deletedAt !== undefined && event.created_at <= deletedAt;
  }

  // Seed pending deletions: applied (with an author check) only when each target
  // event arrives. A forged kind:5 for an id its publisher doesn't own therefore
  // never suppresses the real note.
  for (const [eventId, deleters] of eDeletions) {
    for (const deleter of deleters) {
      store.dispatch(trackPendingDeletion({ eventId, deleter }));
    }
  }
  if (deletedAddrTimestamps.size > 0) {
    store.dispatch(restoreDeletedAddrIds(Object.fromEntries(deletedAddrTimestamps)));
  }

  // Shared-project rotation stubs are never shown: record each redirect and
  // drop the stub plus any older copy of the release at its address.
  const stubAt = new Map<string, number>();
  for (const e of [...trackEvents, ...albumEvents]) {
    const movedTo = movedTargetOf(e);
    if (!movedTo) continue;
    const from = addressOf(e);
    if ((stubAt.get(from) ?? -1) >= e.created_at) continue;
    stubAt.set(from, e.created_at);
    store.dispatch(recordMovedRelease({ from, to: movedTo, at: e.created_at }));
  }
  if (stubAt.size > 0) retireMovedProjectKeys().catch(() => {});
  const supersededByStub = (e: import("../../../types/nostr").NostrEvent) => {
    const at = stubAt.get(addressOf(e));
    return at !== undefined && e.created_at <= at;
  };

  const liveTrackEvents = trackEvents.filter(
    (e) => !isEDeletedByAuthor(e) && !isDeletedByAddr(e, EVENT_KINDS.MUSIC_TRACK) && !supersededByStub(e),
  );
  const liveAlbumEvents = albumEvents.filter(
    (e) => !isEDeletedByAuthor(e) && !isDeletedByAddr(e, EVENT_KINDS.MUSIC_ALBUM) && !supersededByStub(e),
  );
  const livePlaylistEvents = playlistEvents.filter(
    (e) => !isEDeletedByAuthor(e) && !isDeletedByAddr(e, EVENT_KINDS.MUSIC_PLAYLIST),
  );

  // Helper to index a parsed track into Redux
  const indexParsedTrack = (track: import("../../../types/music").MusicTrack) => {
    if (track.artistPubkeys.length > 0) {
      for (const pk of track.artistPubkeys) {
        store.dispatch(indexTrackByArtist({ pubkey: pk, addressableId: track.addressableId }));
      }
    } else if (track.artist && track.artist !== track.pubkey) {
      store.dispatch(indexTrackByArtistName({ normalizedName: track.artist.toLowerCase().trim(), addressableId: track.addressableId }));
    } else {
      store.dispatch(indexTrackByArtist({ pubkey: track.pubkey, addressableId: track.addressableId }));
    }
    for (const fp of track.featuredArtists) {
      store.dispatch(indexTrackByArtist({ pubkey: fp, addressableId: track.addressableId }));
    }
    for (const cp of track.collaborators) {
      store.dispatch(indexTrackByArtist({ pubkey: cp, addressableId: track.addressableId }));
    }
    if (track.albumRef) {
      store.dispatch(indexTrackByAlbum({ albumAddrId: track.albumRef, trackAddrId: track.addressableId }));
    }
  };

  // Helper to index a parsed album into Redux
  const indexParsedAlbum = (album: import("../../../types/music").MusicAlbum) => {
    if (album.artistPubkeys.length > 0) {
      for (const pk of album.artistPubkeys) {
        store.dispatch(indexAlbumByArtist({ pubkey: pk, addressableId: album.addressableId }));
      }
    } else if (album.artist && album.artist !== album.pubkey) {
      store.dispatch(indexAlbumByArtistName({ normalizedName: album.artist.toLowerCase().trim(), addressableId: album.addressableId }));
    } else {
      store.dispatch(indexAlbumByArtist({ pubkey: album.pubkey, addressableId: album.addressableId }));
    }
    for (const fp of album.featuredArtists) {
      store.dispatch(indexAlbumByArtist({ pubkey: fp, addressableId: album.addressableId }));
    }
    for (const cp of album.collaborators) {
      store.dispatch(indexAlbumByArtist({ pubkey: cp, addressableId: album.addressableId }));
    }
  };

  if (liveTrackEvents.length > 0) {
    // Separate public and private tracks — private need async NIP-44 decryption
    const publicTracks: typeof liveTrackEvents = [];
    const privateTracks: typeof liveTrackEvents = [];
    for (const e of liveTrackEvents) {
      const isPrivate = e.tags.some(
        (t) => t[0] === "visibility" && (t[1] === "private" || t[1] === "unlisted"),
      );
      if (isPrivate && e.content) {
        privateTracks.push(e);
      } else {
        publicTracks.push(e);
      }
    }

    // Dispatch public tracks immediately (sync)
    if (publicTracks.length > 0) {
      const tracks = publicTracks.map(parseTrackEvent);
      store.dispatch(addTracks(tracks));
      for (const track of tracks) indexParsedTrack(track);
    }

    // Decrypt private tracks async (non-blocking — UI shows public tracks first)
    if (privateTracks.length > 0) {
      Promise.all(
        privateTracks.map((e) => parsePrivateTrackEvent(e, pubkey).catch(() => null)),
      ).then((results) => {
        const decrypted = results.filter(Boolean) as import("../../../types/music").MusicTrack[];
        if (decrypted.length > 0) {
          store.dispatch(addTracks(decrypted));
          for (const track of decrypted) indexParsedTrack(track);
        }
      });
    }
  }
  if (liveAlbumEvents.length > 0) {
    // Same split for albums
    const publicAlbums: typeof liveAlbumEvents = [];
    const privateAlbums: typeof liveAlbumEvents = [];
    for (const e of liveAlbumEvents) {
      const isPrivate = e.tags.some(
        (t) => t[0] === "visibility" && (t[1] === "private" || t[1] === "unlisted"),
      );
      if (isPrivate && e.content) {
        privateAlbums.push(e);
      } else {
        publicAlbums.push(e);
      }
    }

    if (publicAlbums.length > 0) {
      const albums = publicAlbums.map(parseAlbumEvent);
      store.dispatch(addAlbums(albums));
      for (const album of albums) indexParsedAlbum(album);
    }

    if (privateAlbums.length > 0) {
      Promise.all(
        privateAlbums.map((e) => parsePrivateAlbumEvent(e, pubkey).catch(() => null)),
      ).then((results) => {
        const decrypted = results.filter(Boolean) as import("../../../types/music").MusicAlbum[];
        if (decrypted.length > 0) {
          store.dispatch(addAlbums(decrypted));
          for (const album of decrypted) indexParsedAlbum(album);
        }
      });
    }
  }
  if (livePlaylistEvents.length > 0) {
    store.dispatch(addPlaylists(livePlaylistEvents.map(parsePlaylistEvent)));
  }

  // Restore annotations from IndexedDB, filtering deletions
  const liveAnnotationEvents = annotationEvents.filter(
    (e) => !isEDeletedByAuthor(e) && !isDeletedByAddr(e, EVENT_KINDS.MUSIC_TRACK_NOTES),
  );
  for (const evt of liveAnnotationEvents) {
    const annotation = parseAnnotationEvent(evt);
    if (annotation) {
      store.dispatch(addAnnotation(annotation));
    }
  }

  // Step 7d: Load the music library — arrays, its sync record and the
  // folders — in ONE action, so the cross-device sync never sees a half-read
  // library (docs/MUSIC_LIBRARY_SYNC.md §5). A failed read blocks persisting
  // and publishing rather than syncing an empty library over the real one.
  let musicLib: MusicLibraryState | undefined;
  let musicLibWrittenAt = 0;
  let musicFoldersRow: MusicFoldersRow | undefined;
  let musicReadFailed = false;
  try {
    const [libRow, foldersRow] = await Promise.all([loadMusicLibraryWithTime(), loadMusicFolders()]);
    musicLib = libRow?.row;
    musicLibWrittenAt = libRow?.writtenAt ?? 0;
    musicFoldersRow = foldersRow;
  } catch (err) {
    console.error("[music] library read failed — sync paused for this session:", err);
    musicReadFailed = true;
  }
  store.dispatch(
    musicLibraryHydrated({
      arrays: musicLib ?? {},
      record: parseLibraryRecord(musicLib?.sync?.record),
      rowUpdatedAt: Math.floor((musicLibWrittenAt || Date.now()) / 1000),
      folderDocs: parseFolderDocs(musicFoldersRow?.docs),
      recentlyPlayedIds: musicLib?.recentlyPlayedIds ?? [],
      recentlyPlayedAt: musicLib?.recentlyPlayedAt,
      readFailed: musicReadFailed,
    }),
  );
}

/** performLogin step 7e: the music subscriptions and library refills. */
export function subscribeMusic(pubkey: string): void {
  // Step 7e: Subscribe for user's own music events + deletion events from relays
  // Events flow through processIncomingEvent → Redux + IndexedDB persistence
  subscriptionManager.subscribe({
    filters: [
      {
        kinds: [EVENT_KINDS.MUSIC_TRACK, EVENT_KINDS.MUSIC_ALBUM, EVENT_KINDS.MUSIC_PLAYLIST, EVENT_KINDS.MUSIC_TRACK_NOTES, EVENT_KINDS.DELETION],
        authors: [pubkey],
        limit: 500,
      },
    ],
    relayUrls: PROFILE_RELAYS,
  });

  // Step 7e-a: Subscribe for music events where we are tagged (collaborator, featured artist).
  // Without this, private tracks shared with us via p-tags would never arrive.
  subscriptionManager.subscribe({
    filters: [
      {
        kinds: [EVENT_KINDS.MUSIC_TRACK, EVENT_KINDS.MUSIC_ALBUM],
        "#p": [pubkey],
        limit: 200,
      },
    ],
    relayUrls: PROFILE_RELAYS,
  });

  // Step 7e-c: Releases signed by shared-project keys this device holds (they
  // are "mine" too), plus their kind-5 deletes. A key that arrives later by DM
  // widens the subscription on its own.
  const subscribeProjectAuthors = (authors: string[]) => {
    if (authors.length === 0 || store.getState().identity.pubkey !== pubkey) return;
    subscriptionManager.subscribe({
      filters: [
        {
          kinds: [EVENT_KINDS.MUSIC_TRACK, EVENT_KINDS.MUSIC_ALBUM, EVENT_KINDS.DELETION],
          authors,
          limit: 500,
        },
      ],
      relayUrls: PROFILE_RELAYS,
    });
  };
  loginState.cleanupProjectKeyListener?.();
  loginState.cleanupProjectKeyListener = onProjectKeyAdded((projectPubkey) => subscribeProjectAuthors([projectPubkey]));
  hydrateHeldProjectKeys(pubkey).then(subscribeProjectAuthors).catch(() => {});

  // Step 7e-b: Re-fetch any saved items (and folder members) missing from
  // Redux — evicted by TTL, or saved on another device. Events arrive via
  // eventPipeline → IndexedDB + Redux.
  fetchMissingLibraryItems();

  // Step 7e-c: Saved items we DO hold — ask relays for anything newer than
  // our copy, and pull the backend's saved-version rows (which also fetch
  // versions the ingester saw first and raise "updated" notifications).
  {
    const lib = store.getState().music.library;
    watchSavedItemsForUpdates([...lib.savedAlbumIds, ...lib.savedTrackIds]);
    void syncSavedVersions({ force: true });
  }
}
