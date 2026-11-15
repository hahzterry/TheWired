// Listener registries for the shared LiveKit room.
//
// They live apart from `livekitClient.ts` so feature code can subscribe
// without importing it: that module is the one place `livekit-client` is
// value-imported, and it is loaded on demand (see `livekit.ts`). A listener
// registered before the SDK has ever been loaded is simply waiting here when
// the first room comes up. Type-only imports below; nothing here pulls the SDK.
import type { DisconnectReason } from "livekit-client";

/**
 * Coarse room lifecycle hooks for feature code that must react to the
 * shared room (the 1:1 call service watches for its partner joining /
 * leaving). Keeps callService out of the room module's imports.
 */
export interface RoomListener {
  onParticipantConnected?(identity: string): void;
  onParticipantDisconnected?(identity: string): void;
  /** `clientInitiated` = our own disconnect() (hangup, room switch). */
  onDisconnected?(reason: DisconnectReason | undefined, clientInitiated: boolean): void;
  /** A REMOTE participant's tracks are (not) end-to-end encrypted. `false`
   *  in an encrypted room means their client doesn't encrypt (outdated). */
  onParticipantEncryption?(identity: string, encrypted: boolean): void;
}

/** Iterated by the room module when it forwards a room event. */
export const roomListeners = new Set<RoomListener>();

export function addRoomListener(listener: RoomListener): () => void {
  roomListeners.add(listener);
  return () => {
    roomListeners.delete(listener);
  };
}

/** Everyone who resolves tracks (video tiles). Deliberately not bound to one
 *  Room: see `onTrackTopologyChanged`. */
const topologyListeners = new Set<() => void>();

export function notifyTopology(): void {
  for (const cb of [...topologyListeners]) cb();
}

/**
 * Fires whenever a track may have changed: (un)published, (un)subscribed,
 * (un)muted, and when the room itself comes up or goes away.
 *
 * Subscriptions outlive any single Room. They used to be bound to whatever
 * room existed at subscribe time, and did nothing if there was none — but a
 * 1:1 call renders its tiles the moment the call starts, before the room is
 * connected, so the self-view never learned its camera had been published
 * and stayed black for the whole call.
 */
export function onTrackTopologyChanged(cb: () => void): () => void {
  topologyListeners.add(cb);
  return () => {
    topologyListeners.delete(cb);
  };
}
