import { describe, it, expect, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { createTestStore } from "@/__tests__/helpers/createTestStore";
import { setActivePubkey } from "@/lib/db/userStateStore";
import { getDB } from "@/lib/db/database";
import { saveMembers, loadMembers } from "@/lib/db/spaceMembersStore";
import type { Space, SpaceMember, SpaceRole } from "@/types/space";

vi.mock("@/lib/api/roles", () => ({
  fetchAllMemberRoles: vi.fn(),
}));

import * as rolesApi from "@/lib/api/roles";
import { syncSpaceMembers, _resetInFlight } from "../spaceMembers";

const mockFetch = rolesApi.fetchAllMemberRoles as ReturnType<typeof vi.fn>;

function makeRole(overrides: Partial<SpaceRole> = {}): SpaceRole {
  return {
    id: "role-default",
    spaceId: "space-1",
    name: "Member",
    position: 100,
    isDefault: true,
    isAdmin: false,
    permissions: [],
    ...overrides,
  };
}

function makeMember(overrides: Partial<SpaceMember> = {}): SpaceMember {
  return { pubkey: "pk-1", roles: [], joinedAt: 1_000_000, ...overrides };
}

function makeSpace(overrides: Partial<Space> = {}): Space {
  return {
    id: "space-1",
    name: "Test Space",
    hostRelay: "wss://relay.test.com",
    mode: "read-write",
    isPrivate: false,
    adminPubkeys: [],
    memberPubkeys: [],
    feedPubkeys: [],
    creatorPubkey: "a".repeat(64),
    createdAt: 1_000_000,
    ...overrides,
  };
}

beforeEach(async () => {
  const db = await getDB();
  await db.clear("user_state");
  setActivePubkey(null);
  mockFetch.mockReset();
  _resetInFlight();
});

describe("syncSpaceMembers thunk", () => {
  it("writes both spaceConfig.members and spaces.list[*].memberPubkeys atomically", async () => {
    const store = createTestStore({
      spaces: {
        list: [makeSpace()],
        activeSpaceId: null,
        activeChannelId: null,
        subscriptions: {},
        channels: {},
        channelsLoading: {},
        categories: {},
        layoutRevision: {},
        layoutSupported: {},
        pendingInvites: [],
      },
    });

    const member = makeMember({
      pubkey: "pk-admin",
      roles: [makeRole({ id: "admin", name: "Admin", position: 1, isAdmin: true })],
    });
    mockFetch.mockResolvedValue([member]);

    await store.dispatch(syncSpaceMembers("space-1"));

    expect(store.getState().spaceConfig.members["space-1"]).toEqual([member]);
    expect(store.getState().spaces.list[0].memberPubkeys).toEqual(["pk-admin"]);
  });

  it("persists to IndexedDB on successful fetch", async () => {
    const store = createTestStore({
      spaces: {
        list: [makeSpace()],
        activeSpaceId: null,
        activeChannelId: null,
        subscriptions: {},
        channels: {},
        channelsLoading: {},
        categories: {},
        layoutRevision: {},
        layoutSupported: {},
        pendingInvites: [],
      },
    });

    mockFetch.mockResolvedValue([makeMember({ pubkey: "pk-a" })]);
    await store.dispatch(syncSpaceMembers("space-1"));

    const persisted = await loadMembers("space-1");
    expect(persisted).toHaveLength(1);
    expect(persisted?.[0].pubkey).toBe("pk-a");
  });

  it("dedupes concurrent calls for the same spaceId (in-flight cache)", async () => {
    const store = createTestStore();

    let resolveFn: (val: SpaceMember[]) => void = () => {};
    mockFetch.mockReturnValue(
      new Promise<SpaceMember[]>((resolve) => {
        resolveFn = resolve;
      }),
    );

    const p1 = store.dispatch(syncSpaceMembers("space-1"));
    const p2 = store.dispatch(syncSpaceMembers("space-1"));
    const p3 = store.dispatch(syncSpaceMembers("space-1"));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    resolveFn([makeMember({ pubkey: "pk-a" })]);
    await Promise.all([p1, p2, p3]);
  });

  it("does not overwrite existing state when backend returns empty list", async () => {
    const existingMember = makeMember({ pubkey: "pk-existing" });
    const store = createTestStore({
      spaces: {
        list: [makeSpace({ memberPubkeys: ["pk-existing"] })],
        activeSpaceId: null,
        activeChannelId: null,
        subscriptions: {},
        channels: {},
        channelsLoading: {},
        categories: {},
        layoutRevision: {},
        layoutSupported: {},
        pendingInvites: [],
      },
      spaceConfig: {
        roles: {},
        members: { "space-1": [existingMember] },
        overrides: {},
        myPermissions: {},
        myChannelOverrides: {},
        bans: {},
        mutes: {},
        onboardingPending: {},
        loading: {},
      },
    });

    mockFetch.mockResolvedValue([]);
    await store.dispatch(syncSpaceMembers("space-1"));

    expect(store.getState().spaceConfig.members["space-1"]).toEqual([existingMember]);
    expect(store.getState().spaces.list[0].memberPubkeys).toEqual(["pk-existing"]);
  });

  it("falls back gracefully on backend error (keeps existing state)", async () => {
    const existingMember = makeMember({ pubkey: "pk-existing" });
    const store = createTestStore({
      spaces: {
        list: [makeSpace({ memberPubkeys: ["pk-existing"] })],
        activeSpaceId: null,
        activeChannelId: null,
        subscriptions: {},
        channels: {},
        channelsLoading: {},
        categories: {},
        layoutRevision: {},
        layoutSupported: {},
        pendingInvites: [],
      },
      spaceConfig: {
        roles: {},
        members: { "space-1": [existingMember] },
        overrides: {},
        myPermissions: {},
        myChannelOverrides: {},
        bans: {},
        mutes: {},
        onboardingPending: {},
        loading: {},
      },
    });

    mockFetch.mockRejectedValue(new Error("network down"));
    await store.dispatch(syncSpaceMembers("space-1"));

    expect(store.getState().spaceConfig.members["space-1"]).toEqual([existingMember]);
    expect(store.getState().spaces.list[0].memberPubkeys).toEqual(["pk-existing"]);
  });

  it("skips the backend fetch entirely for a nip29-native space (no 'not a member')", async () => {
    const store = createTestStore({
      spaces: {
        list: [makeSpace({ spaceType: "nip29-native" })],
        activeSpaceId: null,
        activeChannelId: null,
        subscriptions: {},
        channels: {},
        channelsLoading: {},
        categories: {},
        layoutRevision: {},
        layoutSupported: {},
        pendingInvites: [],
      },
    });

    await store.dispatch(syncSpaceMembers("space-1"));

    // Relay-native spaces have no backend membership — the fetch (which would
    // 404 / "not a member") must never fire.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("still fetches for decentralized-alite (backend-backed)", async () => {
    const store = createTestStore({
      spaces: {
        list: [makeSpace({ spaceType: "decentralized-alite" })],
        activeSpaceId: null,
        activeChannelId: null,
        subscriptions: {},
        channels: {},
        channelsLoading: {},
        categories: {},
        layoutRevision: {},
        layoutSupported: {},
        pendingInvites: [],
      },
    });
    mockFetch.mockResolvedValue([makeMember({ pubkey: "pk-a" })]);
    await store.dispatch(syncSpaceMembers("space-1"));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("releases in-flight slot after completion (allows refetch)", async () => {
    const store = createTestStore();

    mockFetch.mockResolvedValue([makeMember({ pubkey: "pk-a" })]);
    await store.dispatch(syncSpaceMembers("space-1"));

    mockFetch.mockResolvedValue([makeMember({ pubkey: "pk-b" })]);
    await store.dispatch(syncSpaceMembers("space-1"));

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("seeded with IndexedDB data: replaces with fetched authoritative list", async () => {
    await saveMembers("space-1", [makeMember({ pubkey: "pk-stale" })]);

    const store = createTestStore({
      spaces: {
        list: [makeSpace({ memberPubkeys: ["pk-stale"] })],
        activeSpaceId: null,
        activeChannelId: null,
        subscriptions: {},
        channels: {},
        channelsLoading: {},
        categories: {},
        layoutRevision: {},
        layoutSupported: {},
        pendingInvites: [],
      },
    });

    mockFetch.mockResolvedValue([makeMember({ pubkey: "pk-fresh" })]);
    await store.dispatch(syncSpaceMembers("space-1"));

    expect(store.getState().spaces.list[0].memberPubkeys).toEqual(["pk-fresh"]);
    const persisted = await loadMembers("space-1");
    expect(persisted?.[0].pubkey).toBe("pk-fresh");
  });

  // After a login or account switch every joined space revalidates the roster
  // it just hydrated from IndexedDB. An unchanged answer must not touch the
  // store: each no-op update re-rendered the whole shell, once per space.
  describe("unchanged roster → no store update", () => {
    const spacesState = (memberPubkeys: string[]) => ({
      list: [makeSpace({ memberPubkeys })],
      activeSpaceId: null,
      activeChannelId: null,
      subscriptions: {},
      channels: {},
      channelsLoading: {},
      categories: {},
      layoutRevision: {},
      layoutSupported: {},
      pendingInvites: [],
    });

    /** Count how often the store's state object changes during `run`. */
    async function stateChanges(store: ReturnType<typeof createTestStore>, run: () => Promise<unknown>) {
      let changes = 0;
      let last = store.getState();
      const unsubscribe = store.subscribe(() => {
        if (store.getState() !== last) {
          changes++;
          last = store.getState();
        }
      });
      await run();
      unsubscribe();
      return changes;
    }

    it("a second sync with the same answer changes nothing in the store", async () => {
      const members = [
        makeMember({ pubkey: "pk-1", roles: [makeRole({ id: "admin", isAdmin: true })] }),
        makeMember({ pubkey: "pk-2", roles: [makeRole()] }),
      ];
      const store = createTestStore({ spaces: spacesState([]) });
      // Fresh objects each time, as a real fetch returns.
      mockFetch.mockImplementation(async () => structuredClone(members));

      expect(await stateChanges(store, () => store.dispatch(syncSpaceMembers("space-1")))).toBe(2);
      const listBefore = store.getState().spaces.list;
      const membersBefore = store.getState().spaceConfig.members["space-1"];

      expect(await stateChanges(store, () => store.dispatch(syncSpaceMembers("space-1")))).toBe(0);
      // Same references: nothing subscribed to them re-renders.
      expect(store.getState().spaces.list).toBe(listBefore);
      expect(store.getState().spaceConfig.members["space-1"]).toBe(membersBefore);
    });

    it("thirty spaces revalidating an unchanged roster cause no store updates at all", async () => {
      const ids = Array.from({ length: 30 }, (_, i) => `space-${i}`);
      const members = [makeMember({ pubkey: "pk-1" }), makeMember({ pubkey: "pk-2" })];
      const store = createTestStore({
        spaces: { ...spacesState([]), list: ids.map((id) => makeSpace({ id, memberPubkeys: ["pk-1", "pk-2"] })) },
        spaceConfig: {
          ...createTestStore().getState().spaceConfig,
          members: Object.fromEntries(ids.map((id) => [id, structuredClone(members)])),
        },
      });
      mockFetch.mockImplementation(async () => structuredClone(members));

      const changes = await stateChanges(store, () =>
        Promise.all(ids.map((id) => store.dispatch(syncSpaceMembers(id)))),
      );
      expect(mockFetch).toHaveBeenCalledTimes(30);
      expect(changes).toBe(0);
    });

    it("still persists to IndexedDB when nothing changed", async () => {
      const members = [makeMember({ pubkey: "pk-1" })];
      const store = createTestStore({
        spaces: spacesState(["pk-1"]),
        spaceConfig: { ...createTestStore().getState().spaceConfig, members: { "space-1": structuredClone(members) } },
      });
      mockFetch.mockResolvedValue(structuredClone(members));
      await store.dispatch(syncSpaceMembers("space-1"));
      await vi.waitFor(async () => expect((await loadMembers("space-1"))?.[0].pubkey).toBe("pk-1"));
    });

    it("a changed role updates the roster but leaves the unchanged pubkey list alone", async () => {
      const store = createTestStore({
        spaces: spacesState(["pk-1"]),
        spaceConfig: {
          ...createTestStore().getState().spaceConfig,
          members: { "space-1": [makeMember({ pubkey: "pk-1", roles: [makeRole()] })] },
        },
      });
      const listBefore = store.getState().spaces.list;
      mockFetch.mockResolvedValue([makeMember({ pubkey: "pk-1", roles: [makeRole({ id: "admin", isAdmin: true })] })]);

      expect(await stateChanges(store, () => store.dispatch(syncSpaceMembers("space-1")))).toBe(1);
      expect(store.getState().spaceConfig.members["space-1"][0].roles[0].id).toBe("admin");
      expect(store.getState().spaces.list).toBe(listBefore);
    });

    it("a member joining or leaving updates both slices", async () => {
      const store = createTestStore({
        spaces: spacesState(["pk-1"]),
        spaceConfig: {
          ...createTestStore().getState().spaceConfig,
          members: { "space-1": [makeMember({ pubkey: "pk-1" })] },
        },
      });
      mockFetch.mockResolvedValue([makeMember({ pubkey: "pk-1" }), makeMember({ pubkey: "pk-2" })]);
      expect(await stateChanges(store, () => store.dispatch(syncSpaceMembers("space-1")))).toBe(2);
      expect(store.getState().spaces.list[0].memberPubkeys).toEqual(["pk-1", "pk-2"]);
      expect(store.getState().spaceConfig.members["space-1"]).toHaveLength(2);
    });

    // The comparison is field by field (no JSON.stringify of both rosters on
    // the main thread), so every field has to be covered.
    describe("field-by-field comparison", () => {
      const base = () => [
        makeMember({ pubkey: "pk-1", joinedAt: 10, roles: [makeRole({ id: "r1", permissions: ["a", "b"], color: "#fff" })] }),
        makeMember({ pubkey: "pk-2", joinedAt: 20, roles: [] }),
      ];
      async function changesAfter(fetched: SpaceMember[]) {
        const store = createTestStore({
          spaces: spacesState(["pk-1", "pk-2"]),
          spaceConfig: { ...createTestStore().getState().spaceConfig, members: { "space-1": base() } },
        });
        mockFetch.mockResolvedValue(fetched);
        return stateChanges(store, () => store.dispatch(syncSpaceMembers("space-1")));
      }

      it("identical data in fresh objects is no change", async () => {
        expect(await changesAfter(base())).toBe(0);
      });

      const roleEdits: Array<[string, Partial<SpaceRole>]> = [
        ["id", { id: "r2" }],
        ["spaceId", { spaceId: "other" }],
        ["name", { name: "Renamed" }],
        ["position", { position: 1 }],
        ["color", { color: "#000" }],
        ["color removed", { color: undefined }],
        ["isDefault", { isDefault: false }],
        ["isAdmin", { isAdmin: true }],
        ["a permission added", { permissions: ["a", "b", "c"] }],
        ["a permission swapped", { permissions: ["a", "x"] }],
        ["permissions reordered", { permissions: ["b", "a"] }],
      ];
      it.each(roleEdits)("a role's %s changing is a change", async (_label, edit) => {
        const fetched = base();
        fetched[0].roles[0] = { ...fetched[0].roles[0], ...edit };
        expect(await changesAfter(fetched)).toBe(1); // roster only; the pubkey list is the same
      });

      it("a role added or removed is a change", async () => {
        const added = base();
        added[1].roles = [makeRole()];
        expect(await changesAfter(added)).toBe(1);
        const removed = base();
        removed[0].roles = [];
        expect(await changesAfter(removed)).toBe(1);
      });

      it("a different joinedAt is a change", async () => {
        const fetched = base();
        fetched[1].joinedAt = 21;
        expect(await changesAfter(fetched)).toBe(1);
      });

      it("handles a roster of several thousand members, equal or differing only at the end", async () => {
        const big = () =>
          Array.from({ length: 5000 }, (_, i) =>
            makeMember({ pubkey: `pk-${i}`, joinedAt: i, roles: [makeRole({ permissions: ["read", "write"] })] }),
          );
        const pubkeys = big().map((m) => m.pubkey);
        const store = createTestStore({
          spaces: spacesState(pubkeys),
          spaceConfig: { ...createTestStore().getState().spaceConfig, members: { "space-1": big() } },
        });
        mockFetch.mockResolvedValue(big());
        expect(await stateChanges(store, () => store.dispatch(syncSpaceMembers("space-1")))).toBe(0);

        const changed = big();
        changed[4999].roles[0].isAdmin = true;
        mockFetch.mockResolvedValue(changed);
        expect(await stateChanges(store, () => store.dispatch(syncSpaceMembers("space-1")))).toBe(1);
        expect(store.getState().spaceConfig.members["space-1"][4999].roles[0].isAdmin).toBe(true);
      });
    });

    it("a reordered roster counts as a change", async () => {
      const store = createTestStore({
        spaces: spacesState(["pk-1", "pk-2"]),
        spaceConfig: {
          ...createTestStore().getState().spaceConfig,
          members: { "space-1": [makeMember({ pubkey: "pk-1" }), makeMember({ pubkey: "pk-2" })] },
        },
      });
      mockFetch.mockResolvedValue([makeMember({ pubkey: "pk-2" }), makeMember({ pubkey: "pk-1" })]);
      await store.dispatch(syncSpaceMembers("space-1"));
      expect(store.getState().spaces.list[0].memberPubkeys).toEqual(["pk-2", "pk-1"]);
    });
  });
});
