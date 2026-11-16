// The door to the LiveKit room module for the rest of the app.
//
// `livekitClient.ts` is the one place `livekit-client` is value-imported, and
// the SDK is over half a megabyte minified. Nothing outside `lib/webrtc`
// imports that module directly: feature code imports from here, and the SDK
// is fetched the first time something actually connects. Most sessions never
// make a call, and they no longer pay for one at startup.
//
// Until the module is loaded there is no room, so every query answers as it
// would with no room, and every command on a room is a no-op, without loading
// anything. Only `connectToRoom` triggers the load. Once loaded, calls go
// straight through.
//
// Listener registration (`addRoomListener`, `onTrackTopologyChanged`) lives in
// `roomEvents.ts`, which needs no SDK, so subscribing early just works.
import type { Room, Track } from "livekit-client";
import type { TileSource } from "@/types/calling";
import { preloadable, type Preloadable } from "@/lib/lazyPreload";
import { isChunkLoadError } from "@/lib/lazyWithRetry";
import { MediaEngineLoadError } from "./loadError";
import { mediaEpoch } from "./mediaSession";
import type { ConnectOptions } from "./livekitClient";

export { addRoomListener, onTrackTopologyChanged, type RoomListener } from "./roomEvents";
export type { ConnectOptions };

type LivekitModule = typeof import("./livekitClient");

let loaded: LivekitModule | null = null;

let importRoomModule: () => Promise<LivekitModule> = () => import("./livekitClient");

// A failed download is not kept (`preloadable` forgets it), so the next join
// imports again.
const loader = preloadable(() =>
  importRoomModule().then((mod) => {
    loaded = mod;
    return mod;
  }),
);

/**
 * Load the room module (and with it the SDK). Shared by every caller.
 *
 * A download that fails rejects with `MediaEngineLoadError`, whose message is
 * written for the user: the engine's own ("Failed to fetch dynamically
 * imported module ...") says nothing about what to do. Any other failure is a
 * bug in the module and passes through untouched.
 */
export async function loadLivekit(): Promise<LivekitModule> {
  try {
    return await loader();
  } catch (err) {
    if (isChunkLoadError(err)) throw new MediaEngineLoadError(err);
    throw err;
  }
}

/** Test seam: replace the import, so a test can make the download fail. */
export function setLivekitImporterForTests(importer: (() => Promise<LivekitModule>) | null): void {
  importRoomModule = importer ?? (() => import("./livekitClient"));
}

/** Whether the room module (and the SDK) has been loaded in this session. */
export function isLivekitLoaded(): boolean {
  return loaded !== null;
}

/**
 * Start fetching the SDK ahead of a likely join (an incoming call is ringing,
 * a voice channel is on screen), so the join itself does not wait for it.
 */
export const livekitPreload: Preloadable = { preload: loader.preload };

/** Connect to a room. Loads the SDK first if this is the first connection. */
export async function connectToRoom(
  serverUrl: string,
  token: string,
  opts: ConnectOptions = {},
): Promise<Room> {
  if (loaded) return loaded.connectToRoom(serverUrl, token, opts);
  // Pin the epoch before waiting for the SDK: an account change while it
  // downloads must abort this join exactly like one during the token fetch.
  const epoch = opts.epoch ?? mediaEpoch();
  const mod = await loadLivekit();
  return mod.connectToRoom(serverUrl, token, { ...opts, epoch });
}

export async function disconnectFromRoom(): Promise<void> {
  await loaded?.disconnectFromRoom();
}

export async function resumeAudioPlayback(): Promise<void> {
  await loaded?.resumeAudioPlayback();
}

export async function setMicrophoneEnabled(enabled: boolean): Promise<void> {
  await loaded?.setMicrophoneEnabled(enabled);
}

export async function setCameraEnabled(enabled: boolean): Promise<void> {
  await loaded?.setCameraEnabled(enabled);
}

export async function setScreenShareEnabled(enabled: boolean): Promise<void> {
  await loaded?.setScreenShareEnabled(enabled);
}

/** The current LiveKit room (null when not connected). */
export function getLivekitRoom(): Room | null {
  return loaded?.getLivekitRoom() ?? null;
}

/** A participant's current track for a tile source, or null. */
export function getParticipantTrack(
  pubkey: string,
  source: TileSource,
  isLocal = false,
): Track | null {
  return loaded?.getParticipantTrack(pubkey, source, isLocal) ?? null;
}

/** The microphone track being published, as a MediaStream (level meter). */
export function getLocalMicrophoneStream(): MediaStream | null {
  return loaded?.getLocalMicrophoneStream() ?? null;
}
