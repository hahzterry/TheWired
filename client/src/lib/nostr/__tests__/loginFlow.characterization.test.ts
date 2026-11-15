/**
 * Characterization of the login path: what `loginFlow` does today, recorded
 * as one ordered log of every store dispatch and every call it makes on its
 * collaborators (relay manager, subscription manager, signers, IndexedDB
 * state, persistence listeners, feature bootstraps).
 *
 * The logs are the contract. They pin
 *  - login with each signer type (NIP-07, OS keychain, NIP-46 bunker),
 *  - session restore (multi-account, legacy, unavailable signer, re-entrancy),
 *  - the bootstrap order: what is hydrated from cache, what is subscribed,
 *    and what must be loaded before which subscription opens,
 *  - the relay-list (kind 10002) and DM-relay (kind 10050) bootstraps,
 *  - account switch, add, remove,
 *  - cleanup and logout: what is torn down, and in which order.
 *
 * The real `loginFlow`, store, slices and IndexedDB user state run; every
 * collaborator with a side effect is a logging stub. Stubs that stand for
 * I/O (IndexedDB, IPC, network) resolve on a later macrotask, as the real
 * ones do.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Node's macrotask scheduler (jsdom's DOM typings do not declare it).
declare function setImmediate(callback: () => void): unknown;

const h = vi.hoisted(() => {
  const log: string[] = [];
  /** 64-hex ids and pubkeys print as `#<hex without leading zeros>`. */
  const alias = (s: string) => s.replace(/[0-9a-f]{64}/g, (m) => "#" + (m.replace(/^0+/, "") || "0"));
  const fmt = (v: unknown): string => {
    if (typeof v === "function") return "<fn>";
    const json = JSON.stringify(v, (_k, val) => {
      if (typeof val === "function") return "<fn>";
      if (val instanceof Map) return { map: [...val.entries()] };
      if (val && typeof val === "object" && !Array.isArray(val) && typeof val.id === "string" && typeof val.sig === "string") {
        return `event:${val.id}`;
      }
      if (val && typeof val === "object" && typeof val.addressableId === "string" && Object.keys(val).length > 4) {
        return { addressableId: val.addressableId };
      }
      return val;
    });
    const out = alias(json ?? "undefined");
    return out.length > 260 ? `${out.slice(0, 260)}…` : out;
  };
  const call = (name: string, ...args: unknown[]) => {
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
    log.push(`${name}(${args.map(fmt).join(", ")})`);
  };
  /** Resolve on a later macrotask, like IndexedDB / IPC / the network. */
  const io = <T,>(value?: T): Promise<T> => new Promise((resolve) => setImmediate(() => resolve(value as T)));
  /** A persistence "start" stub: logs, and returns a stop function that logs. */
  const starter = (name: string) => (...args: unknown[]) => {
    call(name, ...args);
    return () => call(`stop:${name}`);
  };
  /** Wrap the named function exports of a real module so each call is logged. */
  const spyOn = <M extends Record<string, unknown>>(real: M, names: string[]): M => {
    const out: Record<string, unknown> = { ...real };
    for (const name of names) {
      const fn = real[name] as (...a: unknown[]) => unknown;
      out[name] = (...args: unknown[]) => {
        call(name, ...args);
        return fn(...args);
      };
    }
    return out as M;
  };

  interface Sub {
    via: "relayManager" | "subscriptionManager";
    params: {
      filters: Array<Record<string, unknown>>;
      relayUrls?: string[];
      onEvent?: (event: unknown, relayUrl?: string) => void;
      onEOSE?: (subId: string, relayUrl: string) => void;
    };
  }
  const cfg = {
    /** What the active signer answers for getPublicKey. */
    signerPubkey: "",
    detect: "nip07" as "nip07" | "tauri" | null,
    bootstrapFails: false,
    bunkerOffline: false,
    secretPubkeys: {} as Record<string, string>,
    generatedPubkey: "",
    storedProfile: undefined as unknown,
    spaces: [] as unknown[],
    mySpaces: [] as unknown[] | Error,
    members: new Map<string, unknown[]>(),
    channels: {} as Record<string, unknown[]>,
    categories: {} as Record<string, unknown>,
    eventsByKind: {} as Record<number, unknown[]>,
    heldProjectKeys: [] as string[],
    secrets: new Map<string, string>(),
    connections: new Map<string, unknown>(),
    subs: [] as Sub[],
    relayCallbacks: null as null | Record<string, (...a: never[]) => void>,
    reconnectHandlers: [] as Array<() => void>,
    projectKeyListener: null as null | ((pk: string) => void),
    authUrlHandler: null as null | ((url: string) => void),
  };
  return { log, fmt, call, io, starter, spyOn, cfg };
});

// ── Relay layer ──────────────────────────────────────────────────────────────
vi.mock("@/lib/nostr/relayManager", () => {
  const base: Record<string, unknown> = {
    setGlobalCallbacks: (cb: Record<string, (...a: never[]) => void>) => {
      h.call("relayManager.setGlobalCallbacks", Object.keys(cb));
      h.cfg.relayCallbacks = cb;
    },
    onReconnect: (fn: () => void) => {
      h.call("relayManager.onReconnect");
      h.cfg.reconnectHandlers.push(fn);
      return () => {};
    },
    connectToBootstrapAndWait: async () => {
      h.call("relayManager.connectToBootstrapAndWait");
      await h.io();
      if (h.cfg.bootstrapFails) throw new Error("offline (test)");
    },
    subscribe: (params: never) => {
      const p = params as { filters: Array<Record<string, unknown>>; relayUrls?: string[] };
      h.cfg.subs.push({ via: "relayManager", params });
      h.call("relayManager.subscribe", { filters: p.filters, relayUrls: p.relayUrls });
      return `rm-sub-${h.cfg.subs.length}`;
    },
    getAllConnections: () => h.cfg.connections,
  };
  const relayManager = new Proxy(base, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === "then") return undefined;
      return (...args: unknown[]) => h.call(`relayManager.${key}`, ...args);
    },
  });
  return { relayManager };
});
vi.mock("@/lib/nostr/subscriptionManager", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/subscriptionManager")>()),
  subscriptionManager: {
    subscribe: (params: never) => {
      const p = params as { filters: Array<Record<string, unknown>>; relayUrls?: string[] };
      h.cfg.subs.push({ via: "subscriptionManager", params });
      h.call("subscriptionManager.subscribe", { filters: p.filters, relayUrls: p.relayUrls });
      return `sm-sub-${h.cfg.subs.length}`;
    },
    closeAll: () => h.call("subscriptionManager.closeAll"),
  },
}));
vi.mock("@/lib/nostr/groupSubscriptions", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/groupSubscriptions")>()),
  startBackgroundChatSubs: (spaces: Array<{ id: string }>) => h.call("startBackgroundChatSubs", spaces.map((s) => s.id)),
  openBgChatSub: (space: { id: string }) => h.call("openBgChatSub", space.id),
  closeBgChatSub: (id: string) => h.call("closeBgChatSub", id),
  stopAllBgChatSubs: () => h.call("stopAllBgChatSubs"),
}));
vi.mock("@/lib/nostr/publishOutbox", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/publishOutbox")>()),
  publishOutbox: {
    handleOK: (...a: unknown[]) => h.call("publishOutbox.handleOK", ...a),
    replay: async () => h.call("publishOutbox.replay"),
  },
}));
vi.mock("@/lib/nostr/kickHandler", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/kickHandler")>()),
  handlePotentialKick: async (...a: unknown[]) => h.call("handlePotentialKick", ...a),
}));
vi.mock("@/lib/nostr/relayList", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/relayList")>()),
  loadAndApplyDisabledRelays: async () => {
    h.call("loadAndApplyDisabledRelays");
    await h.io();
  },
}));
vi.mock("@/lib/nostr/dmRelayList", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/dmRelayList")>()),
  clearDMRelayCache: () => h.call("clearDMRelayCache"),
}));
vi.mock("@/lib/nostr/dmRelayListEnsure", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/dmRelayListEnsure")>()),
  ensureAppRelayInOwnDMList: async (...a: unknown[]) => {
    h.call("ensureAppRelayInOwnDMList", ...a);
    await h.io();
  },
}));
vi.mock("@/lib/nostr/publish", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/publish")>()),
  signAndPublish: async (unsigned: { kind: number; tags: string[][] }, relays: string[]) => {
    h.call("signAndPublish", { kind: unsigned.kind, tags: unsigned.tags }, relays);
    await h.io();
    return { ...unsigned, id: "published", sig: "" };
  },
}));
vi.mock("@/lib/nostr/eventPipeline", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/eventPipeline")>()),
  resetEventPipelineCaches: () => h.call("resetEventPipelineCaches"),
  processIncomingEvent: async () => {},
  flushEventPipeline: () => {},
}));
vi.mock("@/lib/nostr/verifyWorkerBridge", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/verifyWorkerBridge")>()),
  verifyBridge: {
    verify: async () => true,
    drainPending: () => h.call("verifyBridge.drainPending"),
    terminate: () => {},
  },
}));
vi.mock("@/lib/nostr/profileCache", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/profileCache")>()),
  profileCache: {
    clear: () => h.call("profileCache.clear"),
    handleProfileEvent: (e: unknown, relay?: string) => h.call("profileCache.handleProfileEvent", e, relay),
  },
}));

// ── Signers ──────────────────────────────────────────────────────────────────
function fakeSigner(kind: string) {
  return {
    getPublicKey: async () => {
      h.call(`${kind}.getPublicKey`);
      await h.io();
      return h.cfg.signerPubkey;
    },
    signEvent: async (e: unknown) => e,
  };
}
vi.mock("@/lib/nostr/signer", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/signer")>()),
  detectSigner: async () => {
    h.call("detectSigner");
    await h.io();
    return h.cfg.detect;
  },
  createSigner: async (type: string) => {
    h.call("createSigner", type);
    await h.io();
    return fakeSigner(`${type}Signer`);
  },
}));
vi.mock("@/lib/nostr/tauriSigner", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/tauriSigner")>()),
  TauriSigner: {
    switchAccount: async (pubkey: string) => {
      h.call("TauriSigner.switchAccount", pubkey);
      await h.io();
      h.cfg.signerPubkey = pubkey; // the Rust-side active key
    },
    importKey: async (secret: string) => {
      h.call("TauriSigner.importKey", secret);
      await h.io();
      h.cfg.signerPubkey = h.cfg.secretPubkeys[secret];
      return h.cfg.signerPubkey;
    },
    pubkeyForSecret: async (secret: string) => {
      h.call("TauriSigner.pubkeyForSecret", secret);
      await h.io();
      return h.cfg.secretPubkeys[secret];
    },
    generateKey: async () => {
      h.call("TauriSigner.generateKey");
      await h.io();
      h.cfg.signerPubkey = h.cfg.generatedPubkey;
      return h.cfg.generatedPubkey;
    },
    clearActive: async () => {
      h.call("TauriSigner.clearActive");
      await h.io();
    },
  },
}));
vi.mock("@/lib/nostr/nip46Signer", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/nip46Signer")>()),
  Nip46Signer: {
    connect: async (uri: string, secret: Uint8Array, opts: { onAuthUrl: (u: string) => void; knownUserPubkey?: string }) => {
      h.call("Nip46Signer.connect", uri, `bytes:${secret.length}`, { knownUserPubkey: opts.knownUserPubkey });
      h.cfg.authUrlHandler = opts.onAuthUrl;
      await h.io();
      if (h.cfg.bunkerOffline) throw new Error("bunker offline (test)");
      return { ...fakeSigner("nip46Signer"), close: async () => h.call("nip46Signer.close") };
    },
  },
}));
vi.mock("@/lib/nostr/secretStore", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/secretStore")>()),
  setSecret: async (key: string, value: string) => {
    h.call("setSecret", key, value);
    await h.io();
    h.cfg.secrets.set(key, value);
  },
  getSecret: async (key: string) => {
    h.call("getSecret", key);
    await h.io();
    return h.cfg.secrets.get(key) ?? null;
  },
  deleteSecret: async (key: string) => {
    h.call("deleteSecret", key);
    await h.io();
    h.cfg.secrets.delete(key);
  },
  purgeWebSecrets: () => h.call("purgeWebSecrets"),
}));
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  invoke: async (cmd: string, args?: unknown) => {
    h.call("invoke", cmd, args);
    await h.io();
  },
}));

// ── IndexedDB-backed state ───────────────────────────────────────────────────
vi.mock("@/lib/db/userStateStore", async (orig) =>
  h.spyOn(await orig<typeof import("@/lib/db/userStateStore")>(), [
    "setActivePubkey", "saveUserState", "getUserState", "getUserStateWithTime",
    "clearAllUserState", "clearAccountState", "migrateUnprefixedState",
  ]),
);
vi.mock("@/lib/db/profileStore", async (orig) => ({
  ...(await orig<typeof import("@/lib/db/profileStore")>()),
  getProfile: async (pubkey: string) => {
    h.call("getProfile", pubkey);
    await h.io();
    return h.cfg.storedProfile;
  },
}));
vi.mock("@/lib/db/spaceStore", async (orig) => ({
  ...(await orig<typeof import("@/lib/db/spaceStore")>()),
  loadSpaces: async () => {
    h.call("loadSpaces");
    await h.io();
    return h.cfg.spaces;
  },
  saveSpaces: async (spaces: Array<{ id: string }>) => {
    h.call("saveSpaces", spaces.map((s) => s.id));
    await h.io();
  },
  addSpaceToStore: async (space: { id: string }) => {
    h.call("addSpaceToStore", space.id);
    await h.io();
  },
  updateSpaceInStore: async (space: { id: string }) => {
    h.call("updateSpaceInStore", space.id);
    await h.io();
  },
  removeSpaceFromStore: async (id: string) => {
    h.call("removeSpaceFromStore", id);
    await h.io();
  },
}));
vi.mock("@/lib/db/spaceMembersStore", async (orig) => ({
  ...(await orig<typeof import("@/lib/db/spaceMembersStore")>()),
  loadAllMembers: async () => {
    h.call("loadAllMembers");
    await h.io();
    return h.cfg.members;
  },
}));
vi.mock("@/lib/db/channelStore", async (orig) => ({
  ...(await orig<typeof import("@/lib/db/channelStore")>()),
  loadChannels: async (spaceId: string) => {
    h.call("loadChannels", spaceId);
    await h.io();
    return h.cfg.channels[spaceId];
  },
  loadCategories: async (spaceId: string) => {
    h.call("loadCategories", spaceId);
    await h.io();
    return h.cfg.categories[spaceId];
  },
}));
vi.mock("@/lib/db/lastChannelCache", async (orig) => ({
  ...(await orig<typeof import("@/lib/db/lastChannelCache")>()),
  initLastChannelCache: async () => {
    h.call("initLastChannelCache");
    await h.io();
  },
  clearLastChannelCache: () => h.call("clearLastChannelCache"),
}));
vi.mock("@/lib/db/eventStore", async (orig) => ({
  ...(await orig<typeof import("@/lib/db/eventStore")>()),
  getEventsByKind: async (kind: number, limit: number) => {
    h.call("getEventsByKind", kind, limit);
    await h.io();
    return h.cfg.eventsByKind[kind] ?? [];
  },
}));
vi.mock("@/lib/api/spaces", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/spaces")>()),
  fetchMySpaces: async () => {
    h.call("fetchMySpaces");
    await h.io();
    if (h.cfg.mySpaces instanceof Error) throw h.cfg.mySpaces;
    return { data: h.cfg.mySpaces };
  },
}));
vi.mock("@/store/thunks/spaceMembers", async (orig) => ({
  ...(await orig<typeof import("@/store/thunks/spaceMembers")>()),
  syncSpaceMembers: (spaceId: string) => ({ type: "thunk/syncSpaceMembers", payload: spaceId }),
}));
vi.mock("@/store/thunks/channelLayout", async (orig) => ({
  ...(await orig<typeof import("@/store/thunks/channelLayout")>()),
  hydrateChannelLayout: (p: { spaceId: string; channels: unknown[]; revision?: number }) => ({
    type: "thunk/hydrateChannelLayout",
    payload: { spaceId: p.spaceId, channels: p.channels.length, revision: p.revision },
  }),
}));

// ── Feature bootstraps and persistence listeners ─────────────────────────────
vi.mock("@/features/dm/dmPersistence", async (orig) => ({
  ...(await orig<typeof import("@/features/dm/dmPersistence")>()),
  loadDMState: async () => {
    h.call("loadDMState");
    await h.io();
  },
  startDMPersistence: h.starter("startDMPersistence"),
  cancelPendingSave: () => h.call("dm.cancelPendingSave"),
  flushPendingSave: () => h.call("dm.flushPendingSave"),
  wireSelfWrapOutboxAcks: () => h.call("wireSelfWrapOutboxAcks"),
}));
vi.mock("@/features/dm/dmReadState", async (orig) => ({
  ...(await orig<typeof import("@/features/dm/dmReadState")>()),
  loadDMReadState: () => h.call("loadDMReadState"),
  startDMReadStateSync: h.starter("startDMReadStateSync"),
  cancelPendingSave: () => h.call("dmReadState.cancelPendingSave"),
  flushPendingSave: () => h.call("dmReadState.flushPendingSave"),
}));
vi.mock("@/features/dm/dmSync", async (orig) => ({
  ...(await orig<typeof import("@/features/dm/dmSync")>()),
  startGiftWrapReconciliation: h.starter("startGiftWrapReconciliation"),
}));
vi.mock("@/lib/nostr/followerPersistence", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/followerPersistence")>()),
  loadFollowerState: async () => {
    h.call("loadFollowerState");
    await h.io();
  },
  startFollowerPersistence: h.starter("startFollowerPersistence"),
  cancelPendingSave: () => h.call("follower.cancelPendingSave"),
  flushPendingSave: () => h.call("follower.flushPendingSave"),
}));
vi.mock("@/lib/nostr/friendRequestPersistence", async (orig) => ({
  ...(await orig<typeof import("@/lib/nostr/friendRequestPersistence")>()),
  loadFriendRequestState: async () => {
    h.call("loadFriendRequestState");
    await h.io();
  },
  startFriendRequestPersistence: h.starter("startFriendRequestPersistence"),
  cancelPendingSave: () => h.call("friendRequest.cancelPendingSave"),
  flushPendingSave: () => h.call("friendRequest.flushPendingSave"),
}));
vi.mock("@/features/notifications/notificationPersistence", async (orig) => ({
  ...(await orig<typeof import("@/features/notifications/notificationPersistence")>()),
  loadNotificationState: async () => {
    h.call("loadNotificationState");
    await h.io();
  },
  startNotificationPersistence: h.starter("startNotificationPersistence"),
  cancelPendingSave: () => h.call("notification.cancelPendingSave"),
  flushPendingSave: () => h.call("notification.flushPendingSave"),
}));
vi.mock("@/features/music/librarySync", async (orig) => ({
  ...(await orig<typeof import("@/features/music/librarySync")>()),
  startMusicLibrarySync: h.starter("startMusicLibrarySync"),
  drainMusicLibrarySync: async () => {
    h.call("drainMusicLibrarySync");
    await h.io();
  },
  flushMusicLibrarySync: () => h.call("flushMusicLibrarySync"),
  cancelMusicLibrarySync: () => h.call("cancelMusicLibrarySync"),
}));
vi.mock("@/features/music/libraryFill", async (orig) => ({
  ...(await orig<typeof import("@/features/music/libraryFill")>()),
  fetchMissingLibraryItems: () => h.call("fetchMissingLibraryItems"),
  resetLibraryFill: () => h.call("resetLibraryFill"),
}));
vi.mock("@/features/music/savedVersionSync", async (orig) => ({
  ...(await orig<typeof import("@/features/music/savedVersionSync")>()),
  syncSavedVersions: async (opts: unknown) => h.call("syncSavedVersions", opts),
  watchSavedItemsForUpdates: (ids: string[]) => h.call("watchSavedItemsForUpdates", ids),
  notifyMusicUpdate: () => {},
}));
vi.mock("@/features/music/sharedKey/projectKeys", async (orig) => ({
  ...(await orig<typeof import("@/features/music/sharedKey/projectKeys")>()),
  clearProjectKeySession: () => h.call("clearProjectKeySession"),
  hydrateHeldProjectKeys: async (pubkey: string) => {
    h.call("hydrateHeldProjectKeys", pubkey);
    await h.io();
    return h.cfg.heldProjectKeys;
  },
  onProjectKeyAdded: (listener: (pk: string) => void) => {
    h.call("onProjectKeyAdded");
    h.cfg.projectKeyListener = listener;
    return () => h.call("stop:onProjectKeyAdded");
  },
  retireMovedProjectKeys: async () => {
    h.call("retireMovedProjectKeys");
    await h.io();
  },
}));
vi.mock("@/features/music/trackParser", async (orig) => {
  const real = await orig<typeof import("@/features/music/trackParser")>();
  return {
    ...real,
    parsePrivateTrackEvent: async (event: never, pubkey: string) => {
      h.call("parsePrivateTrackEvent", event, pubkey);
      await h.io();
      return real.parseTrackEvent(event);
    },
  };
});
vi.mock("@/features/music/albumParser", async (orig) => {
  const real = await orig<typeof import("@/features/music/albumParser")>();
  return {
    ...real,
    parsePrivateAlbumEvent: async (event: never, pubkey: string) => {
      h.call("parsePrivateAlbumEvent", event, pubkey);
      await h.io();
      return real.parseAlbumEvent(event);
    },
  };
});
vi.mock("@/features/profile/pinListWrite", async (orig) => ({
  ...(await orig<typeof import("@/features/profile/pinListWrite")>()),
  notePinListSeen: (event: unknown, pubkey: string) => {
    h.call("notePinListSeen", event, pubkey);
    return true;
  },
}));
vi.mock("@/lib/media/mediaPrefs", async (orig) => ({
  ...(await orig<typeof import("@/lib/media/mediaPrefs")>()),
  hydrateMediaPrefs: async () => {
    h.call("hydrateMediaPrefs");
    await h.io();
  },
  fetchMediaPrefs: async () => h.call("fetchMediaPrefs"),
}));
vi.mock("@/lib/media/mediaGrant", async (orig) => ({
  ...(await orig<typeof import("@/lib/media/mediaGrant")>()),
  ensureMediaGrant: async () => {
    h.call("ensureMediaGrant");
    return null;
  },
  clearMediaGrant: () => h.call("clearMediaGrant"),
}));
vi.mock("@/lib/cache/tokenCache", async (orig) => ({
  ...(await orig<typeof import("@/lib/cache/tokenCache")>()),
  musicTokenCache: { clear: () => h.call("musicTokenCache.clear") },
}));
vi.mock("@/lib/webrtc/mediaSession", async (orig) => ({
  ...(await orig<typeof import("@/lib/webrtc/mediaSession")>()),
  abandonMediaSessions: async () => h.call("abandonMediaSessions"),
}));
vi.mock("@/features/calling/accountChangeMedia", async (orig) => ({
  ...(await orig<typeof import("@/features/calling/accountChangeMedia")>()),
  endMediaSessionsForAccountChange: async () => {
    h.call("endMediaSessionsForAccountChange");
    await h.io();
  },
}));

import {
  performLogin,
  tryRestoreSession,
  switchAccount,
  addAccountFromSecret,
  addGeneratedAccount,
  addBunkerAccount,
  removeAccount,
  performCleanup,
  performLogout,
  getSigner,
  getSignerTimeoutMs,
} from "../loginFlow";
import { store, resetAll } from "@/store";
import { APP_RELAY, BOOTSTRAP_RELAYS, INDEXER_RELAYS } from "../constants";
import { saveUserState, setActivePubkey, clearAllUserState, getUserState } from "@/lib/db/userStateStore";
import { nip46SecretKey } from "../secretStore";
import type { NostrEvent } from "@/types/nostr";

const NOW_MS = Date.parse("2026-01-01T00:00:00Z");
const NOW = NOW_MS / 1000;
const hex64 = (n: number) => n.toString(16).padStart(64, "0");
const SIG = "0".repeat(128);
const ME = hex64(0xa11);
const ALT = hex64(0xa17);
const OTHER = hex64(0xc4f);

let seq = 0;
function ev(kind: number, over: Partial<NostrEvent> = {}): NostrEvent {
  seq += 1;
  return { id: hex64(0xe000 + seq), pubkey: ME, created_at: NOW - 60, kind, tags: [], content: "", sig: SIG, ...over };
}

/** Let pending I/O stubs and IndexedDB requests run. */
async function settle(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(() => r()));
}

/** Everything logged since the last call, then cleared. */
function take(): string[] {
  const out = h.log.slice();
  h.log.length = 0;
  return out;
}

type SubParams = (typeof h.cfg.subs)[number]["params"];
/** The captured subscription whose filters match `pick`. */
function sub(pick: (filters: Array<Record<string, unknown>>) => boolean, nth = 0): SubParams {
  const found = h.cfg.subs.filter((s) => pick(s.params.filters));
  if (!found[nth]) throw new Error("subscription not found");
  return found[nth].params;
}
const kindsOf = (f: Record<string, unknown>) => (f.kinds as number[] | undefined) ?? [];
const relayListSub = () => sub((f) => f.length === 1 && kindsOf(f[0]).includes(10002));
const dmRelaySub = () => sub((f) => f.length === 1 && kindsOf(f[0]).includes(10050));
const userDataSub = (nth = 0) => sub((f) => f.length === 4, nth);
const ownProfileSub = () => sub((f) => f.length === 1 && kindsOf(f[0]).length === 1 && kindsOf(f[0])[0] === 0);
const followerSub = () => sub((f) => f.length === 1 && kindsOf(f[0])[0] === 3 && "#p" in f[0]);
const giftWrapSub = () => sub((f) => f.length === 1 && kindsOf(f[0])[0] === 1059);

function spaceRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, hostRelay: APP_RELAY, name: id, isPrivate: false, adminPubkeys: [], memberPubkeys: [], feedPubkeys: [],
    mode: "read-write", creatorPubkey: ME, createdAt: 0, spaceType: "platform", channelSource: "backend", ...over,
  };
}
function mySpaceEntry(id: string, over: Record<string, unknown> = {}) {
  return {
    space: { id, name: id, picture: null, about: null, mode: "read-write", hostRelay: APP_RELAY, creatorPubkey: ME, memberCount: 1, listed: true },
    channels: [
      { id: `${id}-chat`, spaceId: id, type: "chat", label: "chat", position: 0, isDefault: true, adminOnly: false, slowModeSeconds: 0, temporary: false },
    ],
    categories: [],
    layoutRevision: 3,
    feedPubkeys: [],
    ...over,
  };
}

let dispatchSpy: ReturnType<typeof vi.spyOn>;
const win = window as unknown as Record<string, unknown>;

beforeEach(async () => {
  seq = 0;
  // Leave no session behind from the previous test (signer, listeners).
  performCleanup();
  setActivePubkey(null);
  await clearAllUserState();
  store.dispatch(resetAll());

  Object.assign(h.cfg, {
    signerPubkey: ME, detect: "nip07", bootstrapFails: false, bunkerOffline: false,
    secretPubkeys: {}, generatedPubkey: "", storedProfile: undefined, spaces: [], mySpaces: [],
    members: new Map(), channels: {}, categories: {}, eventsByKind: {}, heldProjectKeys: [],
    secrets: new Map(), connections: new Map(), subs: [], relayCallbacks: null, reconnectHandlers: [],
    projectKeyListener: null, authUrlHandler: null,
  });
  delete win.nostr;
  delete win.__TAURI_INTERNALS__;

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW_MS);
  const real = store.dispatch.bind(store);
  dispatchSpy = vi.spyOn(store, "dispatch").mockImplementation(((a: { type?: string; payload?: unknown }) => {
    h.log.push(`dispatch ${a.type}${a.payload === undefined ? "" : ` ${h.fmt(a.payload)}`}`);
    return real(a as never);
  }) as never);
  h.log.length = 0;
});

afterEach(async () => {
  await settle();
  dispatchSpy.mockRestore();
  vi.useRealTimers();
  delete win.nostr;
  delete win.__TAURI_INTERNALS__;
});

// ─────────────────────────────────────────────────────────────────────────────

describe("performLogin — the bootstrap order", () => {
  it("a first NIP-07 login on an empty device", async () => {
    await performLogin("nip07");
    await settle();
    expect(take()).toMatchInlineSnapshot(`
      [
        "relayManager.setGlobalCallbacks(["onOK","onStatusChange","onRelayRemoved"])",
        "relayManager.onReconnect()",
        "wireSelfWrapOutboxAcks()",
        "relayManager.connectToBootstrapAndWait()",
        "createSigner("nip07")",
        "nip07Signer.getPublicKey()",
        "setActivePubkey("#a11")",
        "dispatch identity/login {"pubkey":"#a11","signerType":"nip07"}",
        "getProfile("#a11")",
        "relayManager.replayAuth()",
        "loadAndApplyDisabledRelays()",
        "getUserState("relay_list")",
        "getUserState("dm_relay_list")",
        "getUserState("follow_list")",
        "getUserState("pinned_notes")",
        "getUserState("mute_list")",
        "relayManager.subscribe({"filters":[{"kinds":[10002],"authors":["#a11"],"limit":1}],"relayUrls":["wss://purplepag.es","wss://user.kindpag.es","ws://localhost:7777","wss://relay.damus.io","wss://relay.primal.net","wss://nos.lol"]})",
        "relayManager.subscribe({"filters":[{"kinds":[10050],"authors":["#a11"],"limit":1}],"relayUrls":["ws://localhost:7777","wss://relay.damus.io","wss://relay.primal.net","wss://nos.lol"]})",
        "relayManager.subscribe({"filters":[{"kinds":[0],"authors":["#a11"],"limit":1},{"kinds":[3],"authors":["#a11"],"limit":1},{"kinds":[10000],"authors":["#a11"],"limit":1},{"kinds":[10001],"authors":["#a11"],"limit":1}],"relayUrls":["ws://localhost:7777","wss://relay.damus.io","wss://re…)",
        "relayManager.subscribe({"filters":[{"kinds":[0],"authors":["#a11"],"limit":1}],"relayUrls":["ws://localhost:7777","wss://purplepag.es","wss://user.kindpag.es","wss://relay.damus.io"]})",
        "initLastChannelCache()",
        "getUserState("enabled_features")",
        "dispatch features/setEnabledFeatures []",
        "getUserState("feed_prefs")",
        "dispatch feedPrefs/setFeedPrefs {"showReplies":false,"showReposts":false,"hiddenPubkeys":[]}",
        "hydrateMediaPrefs()",
        "fetchMediaPrefs()",
        "ensureMediaGrant()",
        "loadSpaces()",
        "fetchMySpaces()",
        "getEventsByKind(31683, 500)",
        "getEventsByKind(33123, 200)",
        "getEventsByKind(30119, 200)",
        "getEventsByKind(31686, 500)",
        "getEventsByKind(5, 500)",
        "getUserStateWithTime("music_library")",
        "getUserState("music_folders")",
        "dispatch music/musicLibraryHydrated {"arrays":{},"record":null,"rowUpdatedAt":1767225600,"folderDocs":{},"recentlyPlayedIds":[],"readFailed":false}",
        "loadNotificationState()",
        "startNotificationPersistence()",
        "subscriptionManager.subscribe({"filters":[{"kinds":[31683,33123,30119,31686,5],"authors":["#a11"],"limit":500}],"relayUrls":["ws://localhost:7777","wss://purplepag.es","wss://user.kindpag.es","wss://relay.damus.io"]})",
        "subscriptionManager.subscribe({"filters":[{"kinds":[31683,33123],"#p":["#a11"],"limit":200}],"relayUrls":["ws://localhost:7777","wss://purplepag.es","wss://user.kindpag.es","wss://relay.damus.io"]})",
        "onProjectKeyAdded()",
        "hydrateHeldProjectKeys("#a11")",
        "fetchMissingLibraryItems()",
        "watchSavedItemsForUpdates([])",
        "syncSavedVersions({"force":true})",
        "getUserState("deletedMessageIds")",
        "loadDMState()",
        "startDMPersistence()",
        "loadDMReadState()",
        "startDMReadStateSync()",
        "startMusicLibrarySync("#a11")",
        "loadFriendRequestState()",
        "startFriendRequestPersistence()",
        "publishOutbox.replay()",
        "getUserState("last_gift_wrap_ts")",
        "subscriptionManager.subscribe({"filters":[{"kinds":[1059],"#p":["#a11"],"limit":200}],"relayUrls":["ws://localhost:7777","wss://relay.damus.io","wss://relay.primal.net","wss://nos.lol"]})",
        "startGiftWrapReconciliation("#a11", <fn>)",
        "loadFollowerState()",
        "startFollowerPersistence()",
        "relayManager.subscribe({"filters":[{"kinds":[3],"#p":["#a11"],"limit":500}],"relayUrls":["ws://localhost:7777","wss://purplepag.es","wss://user.kindpag.es","wss://relay.damus.io"]})",
        "getUserState("session")",
        "saveUserState("session", {"accounts":[{"pubkey":"#a11","signerType":"nip07","addedAt":1767225600000}],"activePubkey":"#a11"})",
        "dispatch identity/setAccounts [{"pubkey":"#a11","signerType":"nip07","addedAt":1767225600000}]",
        "getUserState("onboarding")",
        "dispatch onboarding/restoreOnboardingState",
        "dispatch onboarding/setShowProfileWizard true",
      ]
    `);
    expect(store.getState().identity.pubkey).toBe(ME);
    expect(store.getState().identity.signerType).toBe("nip07");
    expect(getSignerTimeoutMs()).toBe(12_000);
    expect(getSigner()).not.toBeNull();
  });

  it("auto-detects the signer when no type is forced, and fails when there is none", async () => {
    h.cfg.detect = "tauri";
    await performLogin();
    await settle();
    expect(take().filter((l) => /^(detectSigner|createSigner|TauriSigner|dispatch identity\/login)/.test(l))).toMatchInlineSnapshot(`
      [
        "detectSigner()",
        "createSigner("tauri")",
        "dispatch identity/login {"pubkey":"#a11","signerType":"tauri_keystore"}",
      ]
    `);

    performCleanup();
    store.dispatch(resetAll());
    take();
    h.cfg.detect = null;
    await expect(performLogin()).rejects.toThrow(/No signer available/);
    expect(take()).toMatchInlineSnapshot(`
      [
        "relayManager.setGlobalCallbacks(["onOK","onStatusChange","onRelayRemoved"])",
        "relayManager.onReconnect()",
        "wireSelfWrapOutboxAcks()",
        "relayManager.connectToBootstrapAndWait()",
        "detectSigner()",
      ]
    `);
    expect(getSigner()).toBeNull();
  });

  it("a keychain login with a cached session: cached lists, spaces, music and DM state, in order", async () => {
    setActivePubkey(ME);
    await saveUserState("relay_list", [
      { url: "wss://mine.example", mode: "read+write" },
      { url: "wss://write-only.example", mode: "write" },
    ]);
    await saveUserState("dm_relay_list", ["wss://dm.example", APP_RELAY]);
    await saveUserState("follow_list", [OTHER]);
    await saveUserState("pinned_notes", [hex64(0x91)]);
    await saveUserState("mute_list", [{ type: "pubkey", value: hex64(0xbad) }]);
    await saveUserState("active_space", "native1");
    await saveUserState("last_gift_wrap_ts", NOW - 1000);
    await saveUserState("deletedMessageIds", { [hex64(0xd1)]: true });
    setActivePubkey(null);
    take();

    h.cfg.storedProfile = { name: "me", display_name: "Me", created_at: 5 };
    h.cfg.spaces = [spaceRow("plat1"), spaceRow("native1", { spaceType: "nip29-native", channelSource: "relay" })];
    h.cfg.mySpaces = [mySpaceEntry("plat1")];
    h.cfg.members = new Map([["plat1", [{ pubkey: ME }, { pubkey: OTHER }]]]);
    h.cfg.channels = { plat1: [{ id: "plat1-chat", spaceId: "plat1", type: "chat" }], native1: [{ id: "n-chat", spaceId: "native1", type: "chat" }] };
    h.cfg.categories = { plat1: { categories: [], revision: 2 } };
    h.cfg.heldProjectKeys = [hex64(0x9e7)];
    const stub = ev(31683, { tags: [["d", "moved"], ["moved", `31683:${hex64(0x9e7)}:moved`]], created_at: NOW - 50 });
    h.cfg.eventsByKind = {
      31683: [
        ev(31683, { tags: [["d", "pub"], ["title", "Pub"]] }),
        ev(31683, { tags: [["d", "priv"], ["visibility", "private"]], content: "ciphertext" }),
        ev(31683, { tags: [["d", "gone"], ["title", "Gone"]], created_at: NOW - 500 }),
        ev(31683, { tags: [["d", "moved"], ["title", "Old copy"]], created_at: NOW - 100 }),
        stub,
      ],
      33123: [
        ev(33123, { tags: [["d", "lp"], ["title", "LP"]] }),
        ev(33123, { tags: [["d", "privlp"], ["visibility", "unlisted"]], content: "ciphertext" }),
      ],
      30119: [ev(30119, { tags: [["d", "mix"], ["title", "Mix"]] })],
      31686: [ev(31686, { tags: [["d", "n1"], ["a", `31683:${ME}:pub`]], content: "note" })],
      5: [
        ev(5, { tags: [["a", `31683:${ME}:gone`]], created_at: NOW - 400 }),
        ev(5, { tags: [["e", hex64(0x7a6)]] }),
        ev(5, { pubkey: OTHER, tags: [["a", `31683:${ME}:pub`]] }),
      ],
    };

    await performLogin("tauri", ME);
    await settle();
    expect(take()).toMatchInlineSnapshot(`
      [
        "relayManager.setGlobalCallbacks(["onOK","onStatusChange","onRelayRemoved"])",
        "relayManager.onReconnect()",
        "wireSelfWrapOutboxAcks()",
        "relayManager.connectToBootstrapAndWait()",
        "TauriSigner.switchAccount("#a11")",
        "createSigner("tauri")",
        "tauriSigner.getPublicKey()",
        "setActivePubkey("#a11")",
        "dispatch identity/login {"pubkey":"#a11","signerType":"tauri_keystore"}",
        "getProfile("#a11")",
        "relayManager.replayAuth()",
        "loadAndApplyDisabledRelays()",
        "dispatch identity/setProfile {"profile":{"name":"me","display_name":"Me","created_at":5},"createdAt":5}",
        "getUserState("relay_list")",
        "dispatch identity/setRelayList {"entries":[{"url":"wss://mine.example","mode":"read+write"},{"url":"wss://write-only.example","mode":"write"}],"createdAt":0}",
        "relayManager.reconcileUserRelays([{"url":"wss://mine.example","mode":"read+write"},{"url":"wss://write-only.example","mode":"write"}], {"pruneBootstrap":false})",
        "getUserState("dm_relay_list")",
        "dispatch identity/setDMRelayList {"relays":["wss://dm.example","ws://localhost:7777"],"createdAt":0}",
        "relayManager.connect("wss://dm.example")",
        "relayManager.connect("ws://localhost:7777")",
        "getUserState("follow_list")",
        "dispatch identity/setFollowList {"follows":["#c4f"],"createdAt":0}",
        "getUserState("pinned_notes")",
        "dispatch identity/setPinnedNotes {"noteIds":["#91"],"createdAt":0}",
        "getUserState("mute_list")",
        "dispatch identity/setMuteList {"mutes":[{"type":"pubkey","value":"#bad"}],"createdAt":0}",
        "relayManager.subscribe({"filters":[{"kinds":[10002],"authors":["#a11"],"limit":1}],"relayUrls":["wss://purplepag.es","wss://user.kindpag.es","ws://localhost:7777","wss://relay.damus.io","wss://relay.primal.net","wss://nos.lol"]})",
        "relayManager.subscribe({"filters":[{"kinds":[10050],"authors":["#a11"],"limit":1}],"relayUrls":["ws://localhost:7777","wss://relay.damus.io","wss://relay.primal.net","wss://nos.lol"]})",
        "relayManager.subscribe({"filters":[{"kinds":[0],"authors":["#a11"],"limit":1},{"kinds":[3],"authors":["#a11"],"limit":1},{"kinds":[10000],"authors":["#a11"],"limit":1},{"kinds":[10001],"authors":["#a11"],"limit":1}],"relayUrls":["ws://localhost:7777","wss://relay.damus.io","wss://re…)",
        "relayManager.subscribe({"filters":[{"kinds":[0],"authors":["#a11"],"limit":1}],"relayUrls":["ws://localhost:7777","wss://purplepag.es","wss://user.kindpag.es","wss://relay.damus.io"]})",
        "initLastChannelCache()",
        "getUserState("enabled_features")",
        "dispatch features/setEnabledFeatures []",
        "getUserState("feed_prefs")",
        "dispatch feedPrefs/setFeedPrefs {"showReplies":false,"showReposts":false,"hiddenPubkeys":[]}",
        "hydrateMediaPrefs()",
        "fetchMediaPrefs()",
        "ensureMediaGrant()",
        "loadSpaces()",
        "dispatch spaces/setSpaces [{"id":"plat1","hostRelay":"ws://localhost:7777","name":"plat1","isPrivate":false,"adminPubkeys":[],"memberPubkeys":[],"feedPubkeys":[],"mode":"read-write","creatorPubkey":"#a11","createdAt":0,"spaceType":"platform","channelSource":"backend"},{"id":"native1","…",
        "loadAllMembers()",
        "dispatch spaceConfig/setMembers {"spaceId":"plat1","members":[{"pubkey":"#a11"},{"pubkey":"#c4f"}]}",
        "dispatch spaces/updateSpaceMembers {"spaceId":"plat1","members":["#a11","#c4f"]}",
        "dispatch thunk/syncSpaceMembers "plat1"",
        "fetchMySpaces()",
        "loadChannels("plat1")",
        "loadCategories("plat1")",
        "loadChannels("native1")",
        "loadCategories("native1")",
        "dispatch spaces/setChannelLayout {"spaceId":"plat1","channels":[{"id":"plat1-chat","spaceId":"plat1","type":"chat"}],"categories":[],"revision":2}",
        "dispatch spaces/setChannels {"spaceId":"native1","channels":[{"id":"n-chat","spaceId":"native1","type":"chat"}]}",
        "getUserState("active_space")",
        "dispatch spaces/setActiveSpace "native1"",
        "getEventsByKind(31683, 500)",
        "getEventsByKind(33123, 200)",
        "getEventsByKind(30119, 200)",
        "getEventsByKind(31686, 500)",
        "getEventsByKind(5, 500)",
        "dispatch events/trackPendingDeletion {"eventId":"#7a6","deleter":"#a11"}",
        "dispatch events/restoreDeletedAddrIds {"31683:#a11:gone":1767225200}",
        "dispatch music/recordMovedRelease {"from":"31683:#a11:moved","to":"31683:#9e7:moved","at":1767225550}",
        "retireMovedProjectKeys()",
        "dispatch music/addTracks [{"addressableId":"31683:#a11:pub"}]",
        "dispatch music/indexTrackByArtist {"pubkey":"#a11","addressableId":"31683:#a11:pub"}",
        "parsePrivateTrackEvent("event:#e003", "#a11")",
        "dispatch music/addAlbums [{"addressableId":"33123:#a11:lp"}]",
        "dispatch music/indexAlbumByArtist {"pubkey":"#a11","addressableId":"33123:#a11:lp"}",
        "parsePrivateAlbumEvent("event:#e007", "#a11")",
        "dispatch music/addPlaylists [{"addressableId":"30119:#a11:mix"}]",
        "dispatch music/addAnnotation {"addressableId":"31686:#a11:n1"}",
        "getUserStateWithTime("music_library")",
        "getUserState("music_folders")",
        "dispatch music/addTracks [{"addressableId":"31683:#a11:priv"}]",
        "dispatch music/indexTrackByArtist {"pubkey":"#a11","addressableId":"31683:#a11:priv"}",
        "dispatch music/addAlbums [{"addressableId":"33123:#a11:privlp"}]",
        "dispatch music/indexAlbumByArtist {"pubkey":"#a11","addressableId":"33123:#a11:privlp"}",
        "dispatch music/musicLibraryHydrated {"arrays":{},"record":null,"rowUpdatedAt":1767225600,"folderDocs":{},"recentlyPlayedIds":[],"readFailed":false}",
        "loadNotificationState()",
        "startNotificationPersistence()",
        "subscriptionManager.subscribe({"filters":[{"kinds":[31683,33123,30119,31686,5],"authors":["#a11"],"limit":500}],"relayUrls":["ws://localhost:7777","wss://purplepag.es","wss://user.kindpag.es","wss://relay.damus.io"]})",
        "subscriptionManager.subscribe({"filters":[{"kinds":[31683,33123],"#p":["#a11"],"limit":200}],"relayUrls":["ws://localhost:7777","wss://purplepag.es","wss://user.kindpag.es","wss://relay.damus.io"]})",
        "onProjectKeyAdded()",
        "hydrateHeldProjectKeys("#a11")",
        "fetchMissingLibraryItems()",
        "watchSavedItemsForUpdates([])",
        "syncSavedVersions({"force":true})",
        "getUserState("deletedMessageIds")",
        "dispatch events/restoreDeletedMessageIds {"#d1":true}",
        "loadDMState()",
        "subscriptionManager.subscribe({"filters":[{"kinds":[31683,33123,5],"authors":["#9e7"],"limit":500}],"relayUrls":["ws://localhost:7777","wss://purplepag.es","wss://user.kindpag.es","wss://relay.damus.io"]})",
        "startDMPersistence()",
        "loadDMReadState()",
        "startDMReadStateSync()",
        "startMusicLibrarySync("#a11")",
        "loadFriendRequestState()",
        "startFriendRequestPersistence()",
        "startBackgroundChatSubs(["plat1","native1"])",
        "publishOutbox.replay()",
        "getUserState("last_gift_wrap_ts")",
        "subscriptionManager.subscribe({"filters":[{"kinds":[1059],"#p":["#a11"],"since":1766965400}],"relayUrls":["wss://dm.example","ws://localhost:7777","wss://relay.damus.io","wss://relay.primal.net","wss://nos.lol"]})",
        "startGiftWrapReconciliation("#a11", <fn>)",
        "loadFollowerState()",
        "startFollowerPersistence()",
        "relayManager.subscribe({"filters":[{"kinds":[3],"#p":["#a11"],"limit":500}],"relayUrls":["ws://localhost:7777","wss://purplepag.es","wss://user.kindpag.es","wss://relay.damus.io"]})",
        "getUserState("session")",
        "saveUserState("session", {"accounts":[{"pubkey":"#a11","signerType":"tauri_keystore","addedAt":1767225600000}],"activePubkey":"#a11"})",
        "dispatch identity/setAccounts [{"pubkey":"#a11","signerType":"tauri_keystore","addedAt":1767225600000}]",
        "getUserState("onboarding")",
        "dispatch onboarding/restoreOnboardingState",
        "dispatch onboarding/setShowProfileWizard true",
      ]
    `);
  });

  it("recovers the space list from the backend when the local cache is empty", async () => {
    h.cfg.mySpaces = [mySpaceEntry("s1"), mySpaceEntry("s2", { channels: [] })];
    await performLogin("nip07");
    await settle();
    const lines = take();
    const from = lines.findIndex((l) => l.startsWith("loadSpaces"));
    const to = lines.findIndex((l) => l.startsWith("getEventsByKind"));
    expect(lines.slice(from, to)).toMatchInlineSnapshot(`
      [
        "loadSpaces()",
        "fetchMySpaces()",
        "saveSpaces(["s1","s2"])",
        "dispatch thunk/hydrateChannelLayout {"spaceId":"s1","channels":1,"revision":3}",
        "dispatch spaces/setSpaces [{"id":"s1","hostRelay":"ws://localhost:7777","name":"s1","isPrivate":false,"adminPubkeys":[],"memberPubkeys":[],"feedPubkeys":[],"mode":"read-write","creatorPubkey":"#a11","createdAt":0,"listed":true,"spaceType":"platform","channelSource":"backend"},{"id":"s2…",
        "loadAllMembers()",
        "dispatch thunk/syncSpaceMembers "s1"",
        "dispatch thunk/syncSpaceMembers "s2"",
        "loadChannels("s1")",
        "loadCategories("s1")",
        "loadChannels("s2")",
        "loadCategories("s2")",
        "getUserState("active_space")",
        "dispatch spaces/setActiveSpace "s1"",
      ]
    `);
    expect(lines.filter((l) => l.startsWith("startBackgroundChatSubs"))).toMatchInlineSnapshot(`
      [
        "startBackgroundChatSubs(["s1","s2"])",
      ]
    `);
  });

  it("leaves the space list empty when the backend is unreachable", async () => {
    h.cfg.mySpaces = new Error("backend down");
    await performLogin("nip07");
    await settle();
    const lines = take();
    expect(lines.filter((l) => /setSpaces|startBackgroundChatSubs|saveSpaces/.test(l))).toEqual([]);
    expect(store.getState().identity.pubkey).toBe(ME);
  });

  it("reconciles a cached space list against the backend: adds, removes, refreshes; native spaces untouched", async () => {
    h.cfg.spaces = [
      spaceRow("keep"), spaceRow("renamed"), spaceRow("left"),
      spaceRow("native", { spaceType: "nip29-native", channelSource: "relay" }),
    ];
    h.cfg.mySpaces = [
      mySpaceEntry("keep"),
      mySpaceEntry("renamed", { space: { ...mySpaceEntry("renamed").space, name: "New name" } }),
      mySpaceEntry("joined-elsewhere"),
    ];
    await performLogin("nip07");
    await settle();
    expect(
      take().filter((l) =>
        /fetchMySpaces|closeBgChatSub|openBgChatSub|removeSpaceFromStore|updateSpaceInStore|addSpaceToStore|spaces\/(addSpace|removeSpace|updateSpace)\b|thunk\/|Spaces updated/.test(l),
      ),
    ).toMatchInlineSnapshot(`
      [
        "dispatch thunk/syncSpaceMembers "keep"",
        "dispatch thunk/syncSpaceMembers "renamed"",
        "dispatch thunk/syncSpaceMembers "left"",
        "fetchMySpaces()",
        "dispatch spaces/updateSpace {"id":"renamed","hostRelay":"ws://localhost:7777","name":"New name","isPrivate":false,"adminPubkeys":[],"memberPubkeys":[],"feedPubkeys":[],"mode":"read-write","creatorPubkey":"#a11","createdAt":0,"spaceType":"platform","channelSource":"backend"}",
        "updateSpaceInStore("renamed")",
        "closeBgChatSub("left")",
        "dispatch spaces/removeSpace "left"",
        "removeSpaceFromStore("left")",
        "dispatch spaces/addSpace {"id":"joined-elsewhere","hostRelay":"ws://localhost:7777","name":"joined-elsewhere","isPrivate":false,"adminPubkeys":[],"memberPubkeys":[],"feedPubkeys":[],"mode":"read-write","creatorPubkey":"#a11","createdAt":0,"listed":true,"spaceType":"platform","channelS…",
        "addSpaceToStore("joined-elsewhere")",
        "dispatch thunk/hydrateChannelLayout {"spaceId":"joined-elsewhere","channels":1,"revision":3}",
        "openBgChatSub("joined-elsewhere")",
        "dispatch thunk/syncSpaceMembers "joined-elsewhere"",
        "dispatch notifications/addNotification {"id":"space-removed-1767225600000","type":"chat","title":"Spaces updated","body":"A space was removed — you left it on another device or it no longer exists.","timestamp":1767225600000}",
      ]
    `);
    expect(store.getState().spaces.list.map((s) => s.id).sort()).toEqual(["joined-elsewhere", "keep", "native", "renamed"]);
  });

  it("refuses to continue when the signer's key is not the one the session expects", async () => {
    h.cfg.signerPubkey = ALT;
    win.nostr = {};
    await expect(performLogin("nip07", ME)).rejects.toThrow(/Stored key not found/);
    await settle();
    expect(take()).toMatchInlineSnapshot(`
      [
        "relayManager.setGlobalCallbacks(["onOK","onStatusChange","onRelayRemoved"])",
        "relayManager.onReconnect()",
        "wireSelfWrapOutboxAcks()",
        "relayManager.connectToBootstrapAndWait()",
        "createSigner("nip07")",
        "nip07Signer.getPublicKey()",
      ]
    `);
    expect(store.getState().identity.pubkey).toBeNull();
  });

  it("stops at the bootstrap relays when none connects", async () => {
    h.cfg.bootstrapFails = true;
    await expect(performLogin("nip07")).rejects.toThrow(/offline/);
    expect(take()).toMatchInlineSnapshot(`
      [
        "relayManager.setGlobalCallbacks(["onOK","onStatusChange","onRelayRemoved"])",
        "relayManager.onReconnect()",
        "wireSelfWrapOutboxAcks()",
        "relayManager.connectToBootstrapAndWait()",
      ]
    `);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("NIP-46 bunker login", () => {
  const CONN = { bunkerUri: "bunker://abc?relay=wss://b.example", clientSecretHex: "11".repeat(32) };

  it("connects with the given connection, stores it, and never auto-publishes a DM relay list", async () => {
    await performLogin("nip46", undefined, CONN);
    await settle();
    const lines = take();
    expect(lines.slice(0, lines.findIndex((l) => l.startsWith("loadAndApplyDisabledRelays")) + 1)).toMatchInlineSnapshot(`
      [
        "relayManager.setGlobalCallbacks(["onOK","onStatusChange","onRelayRemoved"])",
        "relayManager.onReconnect()",
        "wireSelfWrapOutboxAcks()",
        "relayManager.connectToBootstrapAndWait()",
        "Nip46Signer.connect("bunker://abc?relay=wss://b.example", "bytes:32", {})",
        "nip46Signer.getPublicKey()",
        "setActivePubkey("#a11")",
        "dispatch identity/login {"pubkey":"#a11","signerType":"nip46"}",
        "getProfile("#a11")",
        "setSecret("nip46_#a11", "{\\"bunkerUri\\":\\"bunker://abc?relay=wss://b.example\\",\\"clientSecretHex\\":\\"#1111111111111111111111111111111111111111111111111111111111111111\\"}")",
        "relayManager.replayAuth()",
        "loadAndApplyDisabledRelays()",
      ]
    `);
    expect(store.getState().identity.signerType).toBe("nip46");
    expect(getSignerTimeoutMs()).toBe(90_000);
    expect(h.cfg.secrets.get(nip46SecretKey(ME))).toBe(JSON.stringify(CONN));

    // No kind:10050 anywhere: a bunker user is not asked to sign a default list.
    for (const url of BOOTSTRAP_RELAYS) dmRelaySub().onEOSE?.("s", url);
    await settle();
    expect(take().filter((l) => l.startsWith("signAndPublish"))).toEqual([]);
  });

  it("falls back to the stored connection for a known pubkey, and fails without one", async () => {
    h.cfg.secrets.set(nip46SecretKey(ME), JSON.stringify(CONN));
    await performLogin("nip46", ME);
    await settle();
    expect(take().filter((l) => /^(getSecret|setSecret|Nip46Signer)/.test(l))).toMatchInlineSnapshot(`
      [
        "getSecret("nip46_#a11")",
        "Nip46Signer.connect("bunker://abc?relay=wss://b.example", "bytes:32", {"knownUserPubkey":"#a11"})",
      ]
    `);

    performCleanup();
    store.dispatch(resetAll());
    h.cfg.secrets.clear();
    take();
    await expect(performLogin("nip46", ME)).rejects.toThrow(/No saved bunker connection/);
  });

  it("an auth challenge raises a notification and opens only an https page", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await performLogin("nip46", undefined, CONN);
    await settle();
    take();
    h.cfg.authUrlHandler?.("https://bunker.example/approve");
    h.cfg.authUrlHandler?.("javascript:alert(1)");
    expect(take()).toMatchInlineSnapshot(`
      [
        "dispatch notifications/addNotification {"id":"bunker-auth-1767225600000","type":"chat","title":"Approve in your signer","body":"Your remote signer needs you to approve this request.","timestamp":1767225600000}",
        "dispatch notifications/addNotification {"id":"bunker-auth-1767225600000","type":"chat","title":"Approve in your signer","body":"Your remote signer needs you to approve this request.","timestamp":1767225600000}",
      ]
    `);
    expect(open.mock.calls).toEqual([["https://bunker.example/approve", "_blank", "noopener,noreferrer"]]);
    open.mockRestore();
  });

  it("cleanup closes the remote signer", async () => {
    await performLogin("nip46", undefined, CONN);
    await settle();
    take();
    performCleanup();
    expect(take().filter((l) => l.startsWith("nip46Signer.close"))).toHaveLength(1);
    expect(getSigner()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("tryRestoreSession", () => {
  it("returns false with no stored session", async () => {
    expect(await tryRestoreSession()).toBe(false);
    expect(take()).toMatchInlineSnapshot(`
      [
        "getUserState("session")",
      ]
    `);
  });

  it("restores the active account of a multi-account session through the keychain", async () => {
    await saveUserState("session", {
      accounts: [
        { pubkey: ALT, signerType: "nip07", addedAt: 1 },
        { pubkey: ME, signerType: "tauri_keystore", addedAt: 2 },
      ],
      activePubkey: ME,
    });
    win.__TAURI_INTERNALS__ = {};
    h.cfg.signerPubkey = ""; // set by TauriSigner.switchAccount
    take();
    expect(await tryRestoreSession()).toBe(true);
    await settle();
    const lines = take();
    expect(lines.slice(0, lines.findIndex((l) => l.startsWith("dispatch identity/login")) + 1)).toMatchInlineSnapshot(`
      [
        "getUserState("session")",
        "dispatch identity/setAccounts [{"pubkey":"#a17","signerType":"nip07","addedAt":1},{"pubkey":"#a11","signerType":"tauri_keystore","addedAt":2}]",
        "setActivePubkey("#a11")",
        "relayManager.setGlobalCallbacks(["onOK","onStatusChange","onRelayRemoved"])",
        "relayManager.onReconnect()",
        "wireSelfWrapOutboxAcks()",
        "relayManager.connectToBootstrapAndWait()",
        "TauriSigner.switchAccount("#a11")",
        "createSigner("tauri")",
        "tauriSigner.getPublicKey()",
        "setActivePubkey("#a11")",
        "dispatch identity/login {"pubkey":"#a11","signerType":"tauri_keystore"}",
      ]
    `);
    expect(lines.filter((l) => l.startsWith("saveUserState(\"session\"") || l.startsWith("dispatch identity/setAccounts"))).toMatchInlineSnapshot(`
      [
        "dispatch identity/setAccounts [{"pubkey":"#a17","signerType":"nip07","addedAt":1},{"pubkey":"#a11","signerType":"tauri_keystore","addedAt":2}]",
        "saveUserState("session", {"accounts":[{"pubkey":"#a17","signerType":"nip07","addedAt":1},{"pubkey":"#a11","signerType":"tauri_keystore","addedAt":1767225600000}],"activePubkey":"#a11"})",
        "dispatch identity/setAccounts [{"pubkey":"#a17","signerType":"nip07","addedAt":1},{"pubkey":"#a11","signerType":"tauri_keystore","addedAt":1767225600000}]",
      ]
    `);
  });

  it("migrates a legacy single-account session, then restores it", async () => {
    await saveUserState("session", { pubkey: ME, signerType: "nip07" });
    win.nostr = {};
    take();
    expect(await tryRestoreSession()).toBe(true);
    await settle();
    const lines = take();
    expect(lines.slice(0, lines.findIndex((l) => l.startsWith("relayManager.setGlobalCallbacks")))).toMatchInlineSnapshot(`
      [
        "getUserState("session")",
        "saveUserState("session", {"accounts":[{"pubkey":"#a11","signerType":"nip07","addedAt":1767225600000}],"activePubkey":"#a11"})",
        "dispatch identity/setAccounts [{"pubkey":"#a11","signerType":"nip07","addedAt":1767225600000}]",
        "setActivePubkey("#a11")",
        "migrateUnprefixedState("#a11")",
        "setActivePubkey("#a11")",
      ]
    `);
  });

  it("does not log in when the session's signer is unavailable", async () => {
    const session = (signerType: string) => ({ accounts: [{ pubkey: ME, signerType, addedAt: 1 }], activePubkey: ME });
    await saveUserState("session", session("nip07"));
    expect(await tryRestoreSession()).toBe(false); // no window.nostr
    await saveUserState("session", session("tauri_keystore"));
    expect(await tryRestoreSession()).toBe(false); // not the desktop app
    await saveUserState("session", session("nip46"));
    expect(await tryRestoreSession()).toBe(false); // no stored bunker connection
    expect(take().filter((l) => l.startsWith("relayManager"))).toEqual([]);
  });

  it("a bunker that is offline keeps the account and raises a notice", async () => {
    await saveUserState("session", { accounts: [{ pubkey: ME, signerType: "nip46", addedAt: 1 }], activePubkey: ME });
    h.cfg.secrets.set(nip46SecretKey(ME), JSON.stringify({ bunkerUri: "bunker://x", clientSecretHex: "22".repeat(32) }));
    h.cfg.bunkerOffline = true;
    take();
    expect(await tryRestoreSession()).toBe(false);
    expect(take().filter((l) => l.includes("notifications/addNotification"))).toMatchInlineSnapshot(`
      [
        "dispatch notifications/addNotification {"id":"bunker-offline-1767225600000","type":"chat","title":"Remote signer unavailable","body":"Couldn't reach your bunker. Reconnect when it's online.","timestamp":1767225600000}",
      ]
    `);
    expect((await getUserState<{ accounts: unknown[] }>("session"))?.accounts).toHaveLength(1);
  });

  it("concurrent callers share one restore", async () => {
    await saveUserState("session", { accounts: [{ pubkey: ME, signerType: "nip07", addedAt: 1 }], activePubkey: ME });
    win.nostr = {};
    take();
    const a = tryRestoreSession();
    const b = tryRestoreSession();
    expect(a).toBe(b);
    expect(await a).toBe(true);
    await settle();
    expect(take().filter((l) => l.startsWith("relayManager.connectToBootstrapAndWait"))).toHaveLength(1);
    // Once it has finished, a new call starts a new restore.
    performCleanup();
    const c = tryRestoreSession();
    expect(c).not.toBe(a);
    expect(await c).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("relay list bootstrap (kind 10002)", () => {
  const relayListEvent = (created_at: number, urls: string[][]) =>
    ev(10002, { created_at, tags: urls.map((u) => ["r", ...u]) });

  it("a fresh list is applied, saved, reconciled with bootstrap pruning, and user data re-subscribed on its read relays", async () => {
    await performLogin("nip07");
    await settle();
    take();
    const s = relayListSub();
    expect(s.relayUrls).toEqual([...INDEXER_RELAYS, ...BOOTSTRAP_RELAYS]);
    const event = relayListEvent(NOW - 10, [["wss://a.example"], ["wss://w.example", "write"], ["wss://r.example", "read"]]);
    s.onEvent?.(event);
    // Indexers and bootstrap relays each echo the same event: no second reconcile.
    s.onEvent?.(event);
    s.onEvent?.(relayListEvent(NOW - 20, [["wss://stale.example"]]));
    await settle();
    expect(take()).toMatchInlineSnapshot(`
      [
        "dispatch identity/setRelayList {"entries":[{"url":"wss://a.example","mode":"read+write"},{"url":"wss://w.example","mode":"write"},{"url":"wss://r.example","mode":"read"}],"createdAt":1767225590}",
        "saveUserState("relay_list", [{"url":"wss://a.example","mode":"read+write"},{"url":"wss://w.example","mode":"write"},{"url":"wss://r.example","mode":"read"}])",
        "relayManager.reconcileUserRelays([{"url":"wss://a.example","mode":"read+write"},{"url":"wss://w.example","mode":"write"},{"url":"wss://r.example","mode":"read"}], {"pruneBootstrap":true})",
        "relayManager.subscribe({"filters":[{"kinds":[0],"authors":["#a11"],"limit":1},{"kinds":[3],"authors":["#a11"],"limit":1},{"kinds":[10000],"authors":["#a11"],"limit":1},{"kinds":[10001],"authors":["#a11"],"limit":1}],"relayUrls":["wss://a.example","wss://r.example"]})",
      ]
    `);
  });

  it("with no list anywhere, the query settles with the checked-and-empty sentinel once every relay has answered", async () => {
    await performLogin("nip07");
    await settle();
    take();
    const s = relayListSub();
    const urls = s.relayUrls ?? [];
    for (const url of urls.slice(0, -1)) s.onEOSE?.("s", url);
    expect(take()).toEqual([]);
    s.onEOSE?.("s", urls[urls.length - 1]);
    expect(take()).toMatchInlineSnapshot(`
      [
        "dispatch identity/setRelayList {"entries":[],"createdAt":1}",
      ]
    `);
    vi.advanceTimersByTime(10_000); // the timeout was cleared: nothing settles twice
    expect(take().filter((l) => /setRelayList|reconcileUserRelays/.test(l))).toEqual([]);
  });

  it("with a cached list and no fresh event, the timeout prunes bootstrap relays that step 5 deliberately kept", async () => {
    setActivePubkey(ME);
    await saveUserState("relay_list", [{ url: "wss://mine.example", mode: "read+write" }]);
    setActivePubkey(null);
    await performLogin("nip07");
    await settle();
    take();
    vi.advanceTimersByTime(9_999);
    expect(take()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(take()).toMatchInlineSnapshot(`
      [
        "dispatch identity/setRelayList {"entries":[{"url":"wss://mine.example","mode":"read+write"}],"createdAt":1}",
        "relayManager.reconcileUserRelays([{"url":"wss://mine.example","mode":"read+write"}], {"pruneBootstrap":true})",
        "dispatch identity/setKnownFollowers []",
      ]
    `);
  });

  it("settling after an account switch touches nothing", async () => {
    await performLogin("nip07");
    await settle();
    dispatchSpy.mockRestore();
    store.dispatch(resetAll());
    take();
    vi.advanceTimersByTime(10_000);
    expect(take()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("DM relay bootstrap (kind 10050)", () => {
  const dmListEvent = (created_at: number, urls: string[]) => ev(10050, { created_at, tags: urls.map((u) => ["relay", u]) });

  it("a served list is applied, saved and dialled; once every bootstrap relay answered, the platform relay is ensured on the newest one", async () => {
    await performLogin("nip07");
    await settle();
    take();
    const s = dmRelaySub();
    expect(s.relayUrls).toEqual(BOOTSTRAP_RELAYS);
    s.onEvent?.(dmListEvent(NOW - 100, ["wss://old.example"]));
    s.onEvent?.(dmListEvent(NOW - 10, ["wss://dm1.example", "wss://dm2.example"]));
    s.onEvent?.(dmListEvent(NOW - 50, ["wss://older.example"]));
    for (const url of BOOTSTRAP_RELAYS) s.onEOSE?.("s", url);
    await settle();
    expect(take()).toMatchInlineSnapshot(`
      [
        "dispatch identity/setDMRelayList {"relays":["wss://old.example"],"createdAt":1767225500}",
        "saveUserState("dm_relay_list", ["wss://old.example"])",
        "relayManager.connect("wss://old.example")",
        "dispatch identity/setDMRelayList {"relays":["wss://dm1.example","wss://dm2.example"],"createdAt":1767225590}",
        "saveUserState("dm_relay_list", ["wss://dm1.example","wss://dm2.example"])",
        "relayManager.connect("wss://dm1.example")",
        "relayManager.connect("wss://dm2.example")",
        "dispatch identity/setDMRelayList {"relays":["wss://older.example"],"createdAt":1767225550}",
        "saveUserState("dm_relay_list", ["wss://older.example"])",
        "relayManager.connect("wss://older.example")",
        "ensureAppRelayInOwnDMList("#a11", "nip07", {"relays":["wss://dm1.example","wss://dm2.example"],"createdAt":1767225590})",
      ]
    `);
  });

  it("with no list anywhere, defaults are published once every bootstrap relay has answered, then stored", async () => {
    await performLogin("nip07");
    await settle();
    take();
    const s = dmRelaySub();
    for (const url of BOOTSTRAP_RELAYS.slice(0, -1)) s.onEOSE?.("s", url);
    expect(take()).toEqual([]);
    s.onEOSE?.("s", BOOTSTRAP_RELAYS[BOOTSTRAP_RELAYS.length - 1]);
    await settle();
    expect(take()).toMatchInlineSnapshot(`
      [
        "signAndPublish({"kind":10050,"tags":[["relay","ws://localhost:7777"],["relay","wss://relay.damus.io"],["relay","wss://nos.lol"]]}, ["ws://localhost:7777","wss://relay.damus.io","wss://relay.primal.net","wss://nos.lol"])",
        "dispatch identity/setDMRelayList {"relays":["ws://localhost:7777","wss://relay.damus.io","wss://nos.lol"],"createdAt":1767225600}",
        "saveUserState("dm_relay_list", ["ws://localhost:7777","wss://relay.damus.io","wss://nos.lol"])",
      ]
    `);
  });

  it("a cached list alone publishes nothing and ensures nothing", async () => {
    setActivePubkey(ME);
    await saveUserState("dm_relay_list", ["wss://cached-dm.example"]);
    setActivePubkey(null);
    await performLogin("nip07");
    await settle();
    take();
    for (const url of BOOTSTRAP_RELAYS) dmRelaySub().onEOSE?.("s", url);
    await settle();
    expect(take()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("own user data, followers and the gift-wrap subscription", () => {
  it("kind 0 / 3 / 10000 / 10001 from the user update the identity slice and the cache; others are ignored", async () => {
    await performLogin("nip07");
    await settle();
    take();
    const s = userDataSub();
    expect(s.relayUrls).toEqual(BOOTSTRAP_RELAYS);
    s.onEvent?.(ev(0, { content: JSON.stringify({ name: "me", lud06: "keepme" }) }));
    s.onEvent?.(ev(0, { content: "not json" }));
    s.onEvent?.(ev(3, { tags: [["p", OTHER], ["p", ALT], ["e", "x"]] }));
    s.onEvent?.(ev(10000, { tags: [["p", OTHER], ["t", "spam"], ["word", "gm"], ["e", hex64(0x55)], ["x", "ignored"]] }));
    s.onEvent?.(ev(10001, { tags: [["e", hex64(0x91)]] }));
    s.onEvent?.(ev(0, { pubkey: OTHER, content: "{}" }));
    ownProfileSub().onEvent?.(ev(0, { content: JSON.stringify({ name: "me2" }), created_at: NOW - 5 }));
    await settle();
    expect(take()).toMatchInlineSnapshot(`
      [
        "dispatch identity/setProfile {"profile":{"name":"me","lud06":"keepme","created_at":1767225540},"createdAt":1767225540}",
        "profileCache.handleProfileEvent("event:#e001")",
        "dispatch identity/setFollowList {"follows":["#c4f","#a17"],"createdAt":1767225540}",
        "saveUserState("follow_list", ["#c4f","#a17"])",
        "dispatch identity/setMuteList {"mutes":[{"type":"pubkey","value":"#c4f"},{"type":"tag","value":"spam"},{"type":"word","value":"gm"},{"type":"event","value":"#55"}],"createdAt":1767225540}",
        "saveUserState("mute_list", [{"type":"pubkey","value":"#c4f"},{"type":"tag","value":"spam"},{"type":"word","value":"gm"},{"type":"event","value":"#55"}])",
        "notePinListSeen("event:#e005", "#a11")",
        "dispatch identity/setPinnedNotes {"noteIds":["#91"],"createdAt":1767225540}",
        "saveUserState("pinned_notes", ["#91"])",
        "dispatch identity/setProfile {"profile":{"name":"me2","created_at":1767225595},"createdAt":1767225595}",
        "profileCache.handleProfileEvent("event:#e007")",
      ]
    `);
  });

  it("EOSE marks the profile checked and, with no kind 3 found, the follow list as checked-and-empty", async () => {
    await performLogin("nip07");
    await settle();
    take();
    userDataSub().onEOSE?.("s", APP_RELAY);
    ownProfileSub().onEOSE?.("s", APP_RELAY);
    expect(take()).toMatchInlineSnapshot(`
      [
        "dispatch identity/markProfileChecked",
        "dispatch identity/setFollowList {"follows":[],"createdAt":1}",
        "dispatch identity/markProfileChecked",
      ]
    `);
  });

  it("followers are buffered until EOSE and merged with the cached set; later ones are added one by one", async () => {
    await performLogin("nip07");
    await settle();
    take();
    const s = followerSub();
    s.onEvent?.(ev(3, { pubkey: OTHER, tags: [["p", ME]] }));
    s.onEvent?.(ev(3, { pubkey: OTHER, tags: [["p", ME]] }));
    s.onEvent?.(ev(3, { pubkey: ALT, tags: [["p", hex64(0x1)]] })); // does not follow us
    s.onEvent?.(ev(3, { pubkey: ME, tags: [["p", ME]] })); // our own list
    expect(take()).toEqual([]);
    s.onEOSE?.("s", APP_RELAY);
    s.onEvent?.(ev(3, { pubkey: ALT, tags: [["p", ME]] }));
    vi.advanceTimersByTime(10_000); // the safety timer was cleared
    expect(take()).toMatchInlineSnapshot(`
      [
        "dispatch identity/setKnownFollowers ["#c4f"]",
        "dispatch identity/addKnownFollower "#a17"",
        "dispatch identity/setRelayList {"entries":[],"createdAt":1}",
      ]
    `);
  });

  it("the follower safety timer merges after 10 s without EOSE, and never into another account", async () => {
    await performLogin("nip07");
    await settle();
    take();
    followerSub().onEvent?.(ev(3, { pubkey: OTHER, tags: [["p", ME]] }));
    vi.advanceTimersByTime(10_000);
    expect(take()).toMatchInlineSnapshot(`
      [
        "dispatch identity/setRelayList {"entries":[],"createdAt":1}",
        "dispatch identity/setKnownFollowers ["#c4f"]",
      ]
    `);
  });

  it("the gift-wrap subscription: a first login takes a bounded batch; a returning one looks back three days from its watermark", async () => {
    await performLogin("nip07");
    await settle();
    const first = giftWrapSub();
    expect(first.filters).toEqual([{ kinds: [1059], "#p": [ME], limit: 200 }]);
    expect(first.relayUrls).toEqual(BOOTSTRAP_RELAYS);
    take();
    first.onEOSE?.("s", APP_RELAY);
    await settle();
    expect(take()).toMatchInlineSnapshot(`
      [
        "saveUserState("last_gift_wrap_ts", 1767225600)",
      ]
    `);

    performCleanup();
    store.dispatch(resetAll());
    h.cfg.subs = [];
    setActivePubkey(ME);
    await saveUserState("dm_relay_list", ["wss://dm.example"]);
    setActivePubkey(null);
    await performLogin("nip07");
    await settle();
    const second = giftWrapSub();
    expect(second.filters).toEqual([{ kinds: [1059], "#p": [ME], since: NOW - 3 * 24 * 60 * 60 }]);
    expect(second.relayUrls).toEqual(["wss://dm.example", ...BOOTSTRAP_RELAYS]);
  });

  it("a shared-project key that arrives later widens the project subscription", async () => {
    await performLogin("nip07");
    await settle();
    take();
    h.cfg.projectKeyListener?.(hex64(0x9e7));
    expect(take()).toMatchInlineSnapshot(`
      [
        "subscriptionManager.subscribe({"filters":[{"kinds":[31683,33123,5],"authors":["#9e7"],"limit":500}],"relayUrls":["ws://localhost:7777","wss://purplepag.es","wss://user.kindpag.es","wss://relay.damus.io"]})",
      ]
    `);
  });

  it("an active-space change is persisted while logged in, and no longer after cleanup", async () => {
    h.cfg.spaces = [spaceRow("s1"), spaceRow("s2")];
    h.cfg.mySpaces = [mySpaceEntry("s1"), mySpaceEntry("s2")];
    await performLogin("nip07");
    await settle();
    take();
    const { setActiveSpace } = await import("@/store/slices/spacesSlice");
    store.dispatch(setActiveSpace("s2"));
    await settle();
    expect(take()).toMatchInlineSnapshot(`
      [
        "dispatch spaces/setActiveSpace "s2"",
        "saveUserState("active_space", "s2")",
      ]
    `);
    performCleanup();
    take();
    store.dispatch(setActiveSpace("s1"));
    await settle();
    expect(take().filter((l) => l.startsWith("saveUserState"))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("relay status bridge", () => {
  it("routes relay OKs, status changes, removals and reconnects", async () => {
    await performLogin("nip07");
    await settle();
    take();
    const cb = h.cfg.relayCallbacks as unknown as {
      onOK(id: string, ok: boolean, msg: string, url: string): void;
      onStatusChange(url: string, status: string, error?: string): void;
      onRelayRemoved(url: string): void;
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cb.onOK(hex64(0x1), true, "", "wss://a.example");
    cb.onOK(hex64(0x2), false, "restricted: not a member", "wss://a.example");
    h.cfg.connections = new Map([["wss://a.example", { mode: "read", getLatency: () => 42, getEventCount: () => 7 }]]);
    cb.onStatusChange("wss://a.example", "connecting");
    cb.onStatusChange("wss://a.example", "connected");
    cb.onStatusChange("wss://b.example", "error", "refused");
    cb.onRelayRemoved("wss://a.example");
    for (const fn of h.cfg.reconnectHandlers) fn();
    await settle();
    warn.mockRestore();
    expect(take()).toMatchInlineSnapshot(`
      [
        "publishOutbox.handleOK("#1", true, "wss://a.example")",
        "publishOutbox.handleOK("#2", false, "wss://a.example")",
        "handlePotentialKick("#2", false, "restricted: not a member")",
        "dispatch relays/addRelay {"url":"wss://a.example","status":"connecting","mode":"read","latencyMs":42,"eventCount":7}",
        "dispatch relays/setRelayStatus {"url":"wss://a.example","status":"connected"}",
        "dispatch relays/updateLatency {"url":"wss://a.example","latencyMs":42}",
        "dispatch relays/addRelay {"url":"wss://b.example","status":"error","mode":"read+write","latencyMs":0,"eventCount":0,"error":"refused"}",
        "dispatch relays/removeRelay "wss://a.example"",
        "publishOutbox.replay()",
      ]
    `);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("cleanup and logout — teardown order", () => {
  it("performCleanup: flush while the old account is active, stop listeners, close subs, clear caches, drop relays", async () => {
    await performLogin("nip07");
    await settle();
    take();
    performCleanup();
    expect(take()).toMatchInlineSnapshot(`
      [
        "abandonMediaSessions()",
        "dm.flushPendingSave()",
        "dmReadState.flushPendingSave()",
        "follower.flushPendingSave()",
        "friendRequest.flushPendingSave()",
        "notification.flushPendingSave()",
        "flushMusicLibrarySync()",
        "stop:startDMPersistence()",
        "stop:startDMReadStateSync()",
        "stop:startFollowerPersistence()",
        "stop:startFriendRequestPersistence()",
        "stop:startNotificationPersistence()",
        "stop:startMusicLibrarySync()",
        "resetLibraryFill()",
        "stop:startGiftWrapReconciliation()",
        "stop:onProjectKeyAdded()",
        "clearProjectKeySession()",
        "subscriptionManager.closeAll()",
        "stopAllBgChatSubs()",
        "profileCache.clear()",
        "clearDMRelayCache()",
        "clearLastChannelCache()",
        "resetEventPipelineCaches()",
        "verifyBridge.drainPending()",
        "clearMediaGrant()",
        "musicTokenCache.clear()",
        "relayManager.disconnectAll()",
        "dispatch relays/clearRelayConnections",
      ]
    `);
    expect(getSigner()).toBeNull();
    // Listeners were released: a second cleanup stops nothing twice.
    performCleanup();
    expect(take().filter((l) => l.startsWith("stop:"))).toEqual([]);
  });

  it("performLogout: end media and drain sync while the signer is live, cancel (not flush) saves, tear down, wipe state", async () => {
    await performLogin("nip07");
    await settle();
    take();
    await performLogout();
    await settle();
    expect(take()).toMatchInlineSnapshot(`
      [
        "endMediaSessionsForAccountChange()",
        "drainMusicLibrarySync()",
        "dm.cancelPendingSave()",
        "dmReadState.cancelPendingSave()",
        "follower.cancelPendingSave()",
        "friendRequest.cancelPendingSave()",
        "notification.cancelPendingSave()",
        "cancelMusicLibrarySync()",
        "stop:startDMPersistence()",
        "stop:startDMReadStateSync()",
        "stop:startFollowerPersistence()",
        "stop:startFriendRequestPersistence()",
        "stop:startNotificationPersistence()",
        "stop:startMusicLibrarySync()",
        "resetLibraryFill()",
        "stop:startGiftWrapReconciliation()",
        "stop:onProjectKeyAdded()",
        "clearProjectKeySession()",
        "subscriptionManager.closeAll()",
        "stopAllBgChatSubs()",
        "profileCache.clear()",
        "clearDMRelayCache()",
        "clearLastChannelCache()",
        "resetEventPipelineCaches()",
        "verifyBridge.drainPending()",
        "clearMediaGrant()",
        "musicTokenCache.clear()",
        "setActivePubkey(null)",
        "abandonMediaSessions()",
        "relayManager.disconnectAll()",
        "dispatch relays/clearRelayConnections",
        "TauriSigner.clearActive()",
        "purgeWebSecrets()",
        "clearAllUserState()",
        "dispatch store/RESET_ALL",
      ]
    `);
    expect(getSigner()).toBeNull();
    expect(store.getState().identity.pubkey).toBeNull();
    expect(await getUserState("session")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("account switching", () => {
  async function twoAccounts(altType = "tauri_keystore") {
    await saveUserState("session", {
      accounts: [
        { pubkey: ME, signerType: "nip07", addedAt: 1 },
        { pubkey: ALT, signerType: altType, addedAt: 2 },
      ],
      activePubkey: ME,
    });
    await performLogin("nip07", ME);
    await settle();
    take();
  }

  it("switchAccount: end media, drain, clean up, switch the keystore, re-prefix storage, reset the store, then log in", async () => {
    await twoAccounts();
    await switchAccount(ALT);
    await settle();
    const lines = take();
    expect(lines.slice(0, lines.findIndex((l) => l.startsWith("dispatch identity/login")) + 1)).toMatchInlineSnapshot(`
      [
        "getUserState("session")",
        "dispatch identity/setSwitchingAccount true",
        "endMediaSessionsForAccountChange()",
        "drainMusicLibrarySync()",
        "abandonMediaSessions()",
        "dm.flushPendingSave()",
        "dmReadState.flushPendingSave()",
        "follower.flushPendingSave()",
        "friendRequest.flushPendingSave()",
        "notification.flushPendingSave()",
        "flushMusicLibrarySync()",
        "stop:startDMPersistence()",
        "stop:startDMReadStateSync()",
        "stop:startFollowerPersistence()",
        "stop:startFriendRequestPersistence()",
        "stop:startNotificationPersistence()",
        "stop:startMusicLibrarySync()",
        "resetLibraryFill()",
        "stop:startGiftWrapReconciliation()",
        "stop:onProjectKeyAdded()",
        "clearProjectKeySession()",
        "subscriptionManager.closeAll()",
        "stopAllBgChatSubs()",
        "profileCache.clear()",
        "clearDMRelayCache()",
        "clearLastChannelCache()",
        "resetEventPipelineCaches()",
        "verifyBridge.drainPending()",
        "clearMediaGrant()",
        "musicTokenCache.clear()",
        "relayManager.disconnectAll()",
        "dispatch relays/clearRelayConnections",
        "TauriSigner.switchAccount("#a17")",
        "setActivePubkey("#a17")",
        "dispatch store/RESET_ALL",
        "saveUserState("session", {"accounts":[{"pubkey":"#a11","signerType":"nip07","addedAt":1767225600000},{"pubkey":"#a17","signerType":"tauri_keystore","addedAt":2}],"activePubkey":"#a17"})",
        "relayManager.setGlobalCallbacks(["onOK","onStatusChange","onRelayRemoved"])",
        "relayManager.onReconnect()",
        "wireSelfWrapOutboxAcks()",
        "relayManager.connectToBootstrapAndWait()",
        "TauriSigner.switchAccount("#a17")",
        "createSigner("tauri")",
        "tauriSigner.getPublicKey()",
        "setActivePubkey("#a17")",
        "dispatch identity/login {"pubkey":"#a17","signerType":"tauri_keystore"}",
      ]
    `);
    expect(lines.filter((l) => l.startsWith("dispatch identity/setSwitchingAccount"))).toEqual([
      "dispatch identity/setSwitchingAccount true",
      "dispatch identity/setSwitchingAccount false",
    ]);
    expect(store.getState().identity.pubkey).toBe(ALT);
    expect(store.getState().identity.signerType).toBe("tauri_keystore");
    expect((await getUserState<{ activePubkey: string }>("session"))?.activePubkey).toBe(ALT);
  });

  it("switchAccount to and back between two NIP-07 accounts logs each in as itself", async () => {
    await twoAccounts("nip07");
    h.cfg.signerPubkey = ALT;
    await switchAccount(ALT);
    await settle();
    expect(store.getState().identity.pubkey).toBe(ALT);
    h.cfg.signerPubkey = ME;
    await switchAccount(ME);
    await settle();
    expect(store.getState().identity.pubkey).toBe(ME);
    expect(store.getState().identity.accounts.map((a) => a.pubkey)).toEqual([ME, ALT]);
  });

  it("switchAccount rejects an unknown account before touching anything, and always clears the switching flag", async () => {
    await twoAccounts();
    await expect(switchAccount(OTHER)).rejects.toThrow(/Account not found/);
    expect(take().filter((l) => !l.startsWith("getUserState"))).toEqual([]);

    h.cfg.bootstrapFails = true;
    await expect(switchAccount(ALT)).rejects.toThrow(/offline/);
    expect(store.getState().identity.switchingAccount).toBe(false);
  });

  it("addAccountFromSecret: the active key is a no-op; a new key is imported, then cleanup, reset and login", async () => {
    await twoAccounts();
    h.cfg.secretPubkeys = { "nsec-me": ME, "nsec-new": OTHER };
    expect(await addAccountFromSecret("nsec-me")).toEqual({ status: "already_active" });
    expect(take()).toMatchInlineSnapshot(`
      [
        "TauriSigner.pubkeyForSecret("nsec-me")",
      ]
    `);
    expect(await addAccountFromSecret("nsec-new")).toEqual({ status: "added", pubkey: OTHER });
    await settle();
    const lines = take();
    expect(lines.slice(0, lines.findIndex((l) => l.startsWith("relayManager.setGlobalCallbacks")) + 1)).toMatchInlineSnapshot(`
      [
        "TauriSigner.pubkeyForSecret("nsec-new")",
        "dispatch identity/setSwitchingAccount true",
        "endMediaSessionsForAccountChange()",
        "TauriSigner.importKey("nsec-new")",
        "abandonMediaSessions()",
        "dm.flushPendingSave()",
        "dmReadState.flushPendingSave()",
        "follower.flushPendingSave()",
        "friendRequest.flushPendingSave()",
        "notification.flushPendingSave()",
        "flushMusicLibrarySync()",
        "stop:startDMPersistence()",
        "stop:startDMReadStateSync()",
        "stop:startFollowerPersistence()",
        "stop:startFriendRequestPersistence()",
        "stop:startNotificationPersistence()",
        "stop:startMusicLibrarySync()",
        "resetLibraryFill()",
        "stop:startGiftWrapReconciliation()",
        "stop:onProjectKeyAdded()",
        "clearProjectKeySession()",
        "subscriptionManager.closeAll()",
        "stopAllBgChatSubs()",
        "profileCache.clear()",
        "clearDMRelayCache()",
        "clearLastChannelCache()",
        "resetEventPipelineCaches()",
        "verifyBridge.drainPending()",
        "clearMediaGrant()",
        "musicTokenCache.clear()",
        "relayManager.disconnectAll()",
        "dispatch relays/clearRelayConnections",
        "dispatch store/RESET_ALL",
        "relayManager.setGlobalCallbacks(["onOK","onStatusChange","onRelayRemoved"])",
      ]
    `);
    expect(store.getState().identity.accounts.map((a) => a.pubkey)).toEqual([ME, ALT, OTHER]);
  });

  it("addGeneratedAccount and addBunkerAccount follow the same frame", async () => {
    await twoAccounts();
    h.cfg.generatedPubkey = OTHER;
    await addGeneratedAccount();
    await settle();
    const generated = take();
    h.cfg.signerPubkey = hex64(0xb0b);
    await addBunkerAccount("bunker://y", "33".repeat(32));
    await settle();
    const bunker = take();
    const head = (lines: string[]) => lines.slice(0, lines.findIndex((l) => l.startsWith("relayManager.setGlobalCallbacks")) + 1).filter((l) => !/^(stop:|dispatch relays)/.test(l));
    expect({ generated: head(generated).slice(0, 6), bunker: head(bunker).slice(0, 4) }).toMatchInlineSnapshot(`
      {
        "bunker": [
          "dispatch identity/setSwitchingAccount true",
          "endMediaSessionsForAccountChange()",
          "abandonMediaSessions()",
          "dm.flushPendingSave()",
        ],
        "generated": [
          "dispatch identity/setSwitchingAccount true",
          "endMediaSessionsForAccountChange()",
          "TauriSigner.generateKey()",
          "abandonMediaSessions()",
          "dm.flushPendingSave()",
          "dmReadState.flushPendingSave()",
        ],
      }
    `);
    expect(bunker.filter((l) => l.startsWith("Nip46Signer.connect"))).toMatchInlineSnapshot(`
      [
        "Nip46Signer.connect("bunker://y", "bytes:32", {})",
      ]
    `);
    expect(store.getState().identity.signerType).toBe("nip46");
  });

  it("removeAccount: a background account is only dropped from the list", async () => {
    await twoAccounts();
    win.__TAURI_INTERNALS__ = {};
    await removeAccount(ALT);
    await settle();
    expect(take()).toMatchInlineSnapshot(`
      [
        "getUserState("session")",
        "clearAccountState("#a17")",
        "invoke("keystore_delete_key", {"pubkey":"#a17"})",
        "saveUserState("session", {"accounts":[{"pubkey":"#a11","signerType":"nip07","addedAt":1767225600000}],"activePubkey":"#a11"})",
        "dispatch identity/setAccounts [{"pubkey":"#a11","signerType":"nip07","addedAt":1767225600000}]",
      ]
    `);
    expect(store.getState().identity.pubkey).toBe(ME);
  });

  it("removeAccount: removing the active account ends its call first, then switches to the next one", async () => {
    await twoAccounts();
    await removeAccount(ME);
    await settle();
    const lines = take();
    expect(lines.slice(0, lines.findIndex((l) => l.startsWith("TauriSigner.switchAccount")) + 1).filter((l) => !/^(stop:|dispatch relays)/.test(l)).slice(0, 12)).toMatchInlineSnapshot(`
      [
        "getUserState("session")",
        "endMediaSessionsForAccountChange()",
        "clearAccountState("#a11")",
        "saveUserState("session", {"accounts":[{"pubkey":"#a17","signerType":"tauri_keystore","addedAt":2}],"activePubkey":"#a17"})",
        "getUserState("session")",
        "dispatch identity/setSwitchingAccount true",
        "endMediaSessionsForAccountChange()",
        "drainMusicLibrarySync()",
        "abandonMediaSessions()",
        "dm.flushPendingSave()",
        "dmReadState.flushPendingSave()",
        "follower.flushPendingSave()",
      ]
    `);
    expect(store.getState().identity.pubkey).toBe(ALT);
    expect(store.getState().identity.accounts.map((a) => a.pubkey)).toEqual([ALT]);
  });

  it("removeAccount: the last account is a full logout; a bunker account's stored connection is deleted", async () => {
    await saveUserState("session", { accounts: [{ pubkey: ME, signerType: "nip46", addedAt: 1 }], activePubkey: ME });
    h.cfg.secrets.set(nip46SecretKey(ME), JSON.stringify({ bunkerUri: "bunker://z", clientSecretHex: "44".repeat(32) }));
    await performLogin("nip46", ME);
    await settle();
    take();
    await removeAccount(ME);
    await settle();
    const lines = take();
    expect(lines.slice(0, 6)).toMatchInlineSnapshot(`
      [
        "getUserState("session")",
        "endMediaSessionsForAccountChange()",
        "clearAccountState("#a11")",
        "deleteSecret("nip46_#a11")",
        "endMediaSessionsForAccountChange()",
        "drainMusicLibrarySync()",
      ]
    `);
    expect(lines[lines.length - 1]).toBe("dispatch store/RESET_ALL");
    expect(h.cfg.secrets.has(nip46SecretKey(ME))).toBe(false);
  });
});
