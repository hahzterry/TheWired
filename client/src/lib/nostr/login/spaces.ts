import { store } from "../../../store";
import { getUserState } from "../../db/userStateStore";
import {
  loadSpaces,
  saveSpaces,
  addSpaceToStore,
  updateSpaceInStore,
  removeSpaceFromStore,
} from "../../db/spaceStore";
import type { Space, SpaceChannel } from "../../../types/space";
import { isBackendBacked } from "../../../features/spaces/spaceType";
import { loadAllMembers } from "../../db/spaceMembersStore";
import { setMembers } from "../../../store/slices/spaceConfigSlice";
import { updateSpaceMembers } from "../../../store/slices/spacesSlice";
import { syncSpaceMembers } from "../../../store/thunks/spaceMembers";
import {
  setSpaces,
  addSpace,
  updateSpace,
  removeSpace,
  setChannels,
  setChannelLayout,
  setActiveSpace,
} from "../../../store/slices/spacesSlice";
import { addNotification } from "../../../store/slices/notificationSlice";
import { fetchMySpaces } from "../../api/spaces";
import { openBgChatSub, closeBgChatSub } from "../groupSubscriptions";
import { loadChannels, loadCategories } from "../../db/channelStore";
import { hydrateChannelLayout } from "../../../store/thunks/channelLayout";
import { createLogger } from "../../debug/logger";

// The joined spaces at login: the cached list, recovery from the backend,
// and the stale-while-revalidate reconcile against `GET /spaces/my-spaces`.

const startupLog = createLogger("startup");

/** One entry of the backend `GET /spaces/my-spaces` response. */
type MySpaceEntry = Awaited<ReturnType<typeof fetchMySpaces>>["data"][number];

/** Map a my-spaces entry to a local Space (same shape the join flow produces). */
function mySpaceEntryToSpace(entry: MySpaceEntry): Space {
  return {
    id: entry.space.id,
    hostRelay: entry.space.hostRelay,
    name: entry.space.name,
    picture: entry.space.picture ?? undefined,
    about: entry.space.about ?? undefined,
    isPrivate: false,
    adminPubkeys: [],
    memberPubkeys: [],
    feedPubkeys: entry.feedPubkeys,
    mode: entry.space.mode,
    creatorPubkey: entry.space.creatorPubkey ?? "",
    createdAt: 0,
    listed: entry.space.listed,
    spaceType: "platform",
    channelSource: "backend",
  };
}

/** Normalize backend channels (backfill feedMode for pre-feedMode rows). */
function normalizeChannels(channels: MySpaceEntry["channels"]): SpaceChannel[] {
  return channels.map((ch: any) => ({ ...ch, feedMode: ch.feedMode ?? "all" }));
}

/**
 * Stale-while-revalidate reconcile of the joined-spaces list against the
 * backend's authoritative membership (`GET /spaces/my-spaces`). The cached
 * list is already on screen when this runs; it then:
 *  - ADDS memberships this device has never seen (joined/created on another
 *    device, or seeded server-side) — the cache-first design otherwise never
 *    shows them, since spaces only enter the cache via local create/join;
 *  - REMOVES backend-backed spaces absent from my-spaces (left on another
 *    device, kicked, or space deleted — this supersedes the old
 *    /spaces/validate purge, which only caught deletions);
 *  - refreshes drifted metadata in place.
 * NIP-29-native spaces are relay-authoritative and never touched. Only spaces
 * present in the login-time snapshot are eligible for removal, so a space
 * joined on THIS device while the fetch was in flight can never be dropped.
 * On fetch failure the cache stays exactly as-is.
 */
async function reconcileMySpaces(cachedSpaces: Space[]): Promise<void> {
  const res = await fetchMySpaces();
  const remoteById = new Map(res.data.map((e) => [e.space.id, e]));
  const cachedIds = new Set(cachedSpaces.map((s) => s.id));
  let removed = 0;

  // Removals + metadata refresh (backend-backed spaces from the snapshot only)
  for (const cached of cachedSpaces) {
    if (!isBackendBacked(cached)) continue;
    const live = store.getState().spaces.list.find((s) => s.id === cached.id);
    if (!live) continue; // already removed elsewhere
    const entry = remoteById.get(cached.id);
    if (!entry) {
      closeBgChatSub(cached.id);
      store.dispatch(removeSpace(cached.id));
      await removeSpaceFromStore(cached.id);
      removed++;
      continue;
    }
    const next: Space = {
      ...live,
      name: entry.space.name,
      picture: entry.space.picture ?? undefined,
      about: entry.space.about ?? undefined,
      mode: entry.space.mode,
      hostRelay: entry.space.hostRelay,
      creatorPubkey: entry.space.creatorPubkey ?? live.creatorPubkey,
      feedPubkeys: entry.feedPubkeys,
    };
    const changed =
      next.name !== live.name ||
      next.picture !== live.picture ||
      next.about !== live.about ||
      next.mode !== live.mode ||
      next.hostRelay !== live.hostRelay ||
      next.creatorPubkey !== live.creatorPubkey ||
      next.feedPubkeys.length !== live.feedPubkeys.length ||
      next.feedPubkeys.some((p, i) => p !== live.feedPubkeys[i]);
    if (changed) {
      store.dispatch(updateSpace(next));
      await updateSpaceInStore(next);
    }
  }

  // Additions. Skip ids that still exist locally — including a nip29-native
  // space that happens to share an id (overwriting it would be a hijack; see
  // addSpace #42).
  const additions = res.data.filter(
    (e) =>
      !cachedIds.has(e.space.id) &&
      !store.getState().spaces.list.some((s) => s.id === e.space.id),
  );
  for (const entry of additions) {
    const space = mySpaceEntryToSpace(entry);
    store.dispatch(addSpace(space));
    await addSpaceToStore(space);
    const channels = normalizeChannels(entry.channels);
    if (channels.length > 0) {
      store.dispatch(
        hydrateChannelLayout({ spaceId: space.id, channels, categories: entry.categories, revision: entry.layoutRevision }),
      );
    }
    // Wire the always-on chat sub + member sync the same way a local join does.
    openBgChatSub(space);
    void store.dispatch(syncSpaceMembers(space.id));
  }

  if (additions.length > 0 || removed > 0) {
    startupLog.info(`spaces reconcile: +${additions.length} added, -${removed} removed`);
  }
  if (removed > 0) {
    const body =
      removed === 1
        ? "A space was removed — you left it on another device or it no longer exists."
        : `${removed} spaces were removed — you left them on another device or they no longer exist.`;
    store.dispatch(
      addNotification({
        id: `space-removed-${Date.now()}`,
        type: "chat",
        title: "Spaces updated",
        body,
        timestamp: Date.now(),
      }),
    );
  }
}

/** performLogin step 7b: the joined spaces — from the cache (or the backend
 *  when the cache is empty), with members, channels and the active space.
 *  Returns the spaces now in the store. */
export async function loadAndReconcileSpaces(): Promise<Space[]> {
  let savedSpaces = await loadSpaces();
  let recoveredFromBackend = false;

  // If local cache is empty, recover from backend (covers logout/reimport,
  // cache wipe, phantom account bug, or first multi-device login). Blocking:
  // there is nothing cached to paint, so wait for the authoritative list.
  if (savedSpaces.length === 0) {
    try {
      const res = await fetchMySpaces();
      if (res.data.length > 0) {
        savedSpaces = res.data.map(mySpaceEntryToSpace);
        recoveredFromBackend = true;

        // Persist recovered spaces + channels to IndexedDB for next startup,
        // and hydrate channels into Redux
        await saveSpaces(savedSpaces);
        for (const entry of res.data) {
          if (entry.channels.length > 0) {
            const channels = normalizeChannels(entry.channels);
            store.dispatch(
              hydrateChannelLayout({
                spaceId: entry.space.id,
                channels,
                categories: entry.categories,
                revision: entry.layoutRevision,
              }),
            );
          }
        }
      }
    } catch {
      // Backend unreachable — spaces will appear empty until next login
    }
  }

  if (savedSpaces.length > 0) {
    store.dispatch(setSpaces(savedSpaces));

    // Hydrate members + roles from IndexedDB so MemberList paints correctly
    // on first render (no admin-as-member flicker). Then fire a background
    // revalidation per space — corrects any drift (kicks/bans/role changes
    // that happened while the app was closed) within seconds.
    try {
      const cachedMembers = await loadAllMembers();
      for (const [spaceId, members] of cachedMembers) {
        store.dispatch(setMembers({ spaceId, members }));
        store.dispatch(
          updateSpaceMembers({ spaceId, members: members.map((m) => m.pubkey) }),
        );
      }
    } catch {
      // IDB read failed — refresh below will populate state from backend
    }
    // Only backend-backed spaces (platform / decentralized A-lite) have members
    // and a directory entry on our backend. NIP-29-native spaces are
    // relay-authoritative — syncing or validating them against the backend
    // would (a) 404 their members and (b) PURGE them as "stale" on every
    // relogin, since the backend has no record of them.
    const backendSpaces = savedSpaces.filter(isBackendBacked);
    for (const space of backendSpaces) {
      void store.dispatch(syncSpaceMembers(space.id));
    }

    // Non-blocking stale-while-revalidate: the cached list is already on
    // screen; reconcile it against the backend's authoritative membership —
    // adds spaces joined on other devices, drops ones left elsewhere or
    // deleted, refreshes drifted metadata. Skipped when the list was just
    // recovered from that same endpoint above.
    if (!recoveredFromBackend) {
      reconcileMySpaces(savedSpaces).catch(() => {});
    }

    // Preload cached channels for all spaces from IndexedDB so the
    // notification evaluator can resolve the correct channel IDs
    // (e.g. "spaceId:ch_abc" instead of fallback "spaceId:chat")
    await Promise.all(
      savedSpaces.map(async (space) => {
        try {
          const [cached, cachedCategories] = await Promise.all([
            loadChannels(space.id),
            loadCategories(space.id).catch(() => undefined),
          ]);
          if (cached && cached.length > 0) {
            if (cachedCategories) {
              store.dispatch(
                setChannelLayout({
                  spaceId: space.id,
                  channels: cached,
                  categories: cachedCategories.categories,
                  revision: cachedCategories.revision,
                }),
              );
            } else {
              store.dispatch(setChannels({ spaceId: space.id, channels: cached }));
            }
          }
        } catch {
          // IndexedDB read failed — channels will be fetched from backend later
        }
      }),
    );

    // Restore active space from IndexedDB (or default to first space)
    const lastActiveSpace = await getUserState<string>("active_space");
    if (lastActiveSpace && savedSpaces.some((s) => s.id === lastActiveSpace)) {
      store.dispatch(setActiveSpace(lastActiveSpace));
    } else {
      store.dispatch(setActiveSpace(savedSpaces[0].id));
    }

    // NOTE: Background chat subs are started AFTER notification state is
    // restored (step 7f-c below) to ensure lastReadTimestamps are available.
    // This prevents re-fetched messages from being double-counted as unread.
  }
  return savedSpaces;
}
