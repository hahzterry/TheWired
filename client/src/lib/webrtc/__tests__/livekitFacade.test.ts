/**
 * The facade that keeps the LiveKit SDK out of startup: nothing loads until
 * something connects, queries answer "no room" meanwhile, and calls pass
 * straight through afterwards.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const impl = vi.hoisted(() => ({
  room: { name: "room" } as unknown,
  connectToRoom: vi.fn(),
  disconnectFromRoom: vi.fn(async () => {}),
  resumeAudioPlayback: vi.fn(async () => {}),
  setMicrophoneEnabled: vi.fn(async () => {}),
  setCameraEnabled: vi.fn(async () => {}),
  setScreenShareEnabled: vi.fn(async () => {}),
  getLivekitRoom: vi.fn(),
  getParticipantTrack: vi.fn(),
  getLocalMicrophoneStream: vi.fn(),
}));

vi.mock("../livekitClient", () => ({
  connectToRoom: impl.connectToRoom,
  disconnectFromRoom: impl.disconnectFromRoom,
  resumeAudioPlayback: impl.resumeAudioPlayback,
  setMicrophoneEnabled: impl.setMicrophoneEnabled,
  setCameraEnabled: impl.setCameraEnabled,
  setScreenShareEnabled: impl.setScreenShareEnabled,
  getLivekitRoom: impl.getLivekitRoom,
  getParticipantTrack: impl.getParticipantTrack,
  getLocalMicrophoneStream: impl.getLocalMicrophoneStream,
}));

/** A fresh facade (and a fresh "SDK not loaded yet" state) per test. */
async function freshFacade() {
  vi.resetModules();
  const facade = await import("../livekit");
  const session = await import("../mediaSession");
  return { facade, session };
}

beforeEach(() => {
  vi.clearAllMocks();
  impl.connectToRoom.mockImplementation(async () => impl.room);
  impl.getLivekitRoom.mockReturnValue(impl.room);
  impl.getParticipantTrack.mockReturnValue({ kind: "video" });
  impl.getLocalMicrophoneStream.mockReturnValue({ id: "mic" });
});

describe("livekit facade", () => {
  it("importing the facade does not load the room module", async () => {
    const { facade } = await freshFacade();
    expect(facade.isLivekitLoaded()).toBe(false);
  });

  it("before anything has connected, queries answer 'no room' without loading", async () => {
    const { facade } = await freshFacade();

    expect(facade.getLivekitRoom()).toBeNull();
    expect(facade.getParticipantTrack("pk", "camera")).toBeNull();
    expect(facade.getLocalMicrophoneStream()).toBeNull();
    expect(facade.isLivekitLoaded()).toBe(false);
    expect(impl.getLivekitRoom).not.toHaveBeenCalled();
  });

  it("before anything has connected, room commands are no-ops and do not load", async () => {
    const { facade } = await freshFacade();

    await facade.disconnectFromRoom();
    await facade.resumeAudioPlayback();
    await facade.setMicrophoneEnabled(true);
    await facade.setCameraEnabled(true);
    await facade.setScreenShareEnabled(true);

    expect(facade.isLivekitLoaded()).toBe(false);
    expect(impl.disconnectFromRoom).not.toHaveBeenCalled();
    expect(impl.setMicrophoneEnabled).not.toHaveBeenCalled();
  });

  it("the first connect loads the module once and forwards the call", async () => {
    const { facade } = await freshFacade();

    const room = await facade.connectToRoom("wss://sfu", "token", { e2ee: { kind: "channel", roomName: "r" } });

    expect(room).toBe(impl.room);
    expect(facade.isLivekitLoaded()).toBe(true);
    expect(impl.connectToRoom).toHaveBeenCalledTimes(1);
    expect(impl.connectToRoom).toHaveBeenCalledWith(
      "wss://sfu",
      "token",
      expect.objectContaining({ e2ee: { kind: "channel", roomName: "r" } }),
    );
  });

  it("pins the media epoch before waiting for the SDK, so an account change during the download aborts the join", async () => {
    const { facade, session } = await freshFacade();
    const before = session.mediaEpoch();

    const pending = facade.connectToRoom("wss://sfu", "token");
    // The account changes while the chunk is still downloading.
    session.invalidateMediaJoins();
    await pending;

    const opts = impl.connectToRoom.mock.calls[0][2] as { epoch: number };
    expect(opts.epoch).toBe(before);
    expect(opts.epoch).not.toBe(session.mediaEpoch());
  });

  it("keeps a caller's own epoch", async () => {
    const { facade } = await freshFacade();
    await facade.connectToRoom("wss://sfu", "token", { epoch: 41 });
    expect(impl.connectToRoom).toHaveBeenCalledWith("wss://sfu", "token", expect.objectContaining({ epoch: 41 }));
  });

  it("once loaded, everything passes straight through", async () => {
    const { facade } = await freshFacade();
    await facade.connectToRoom("wss://sfu", "token");

    expect(facade.getLivekitRoom()).toBe(impl.room);
    expect(facade.getParticipantTrack("pk", "screenshare", true)).toEqual({ kind: "video" });
    expect(impl.getParticipantTrack).toHaveBeenCalledWith("pk", "screenshare", true);
    expect(facade.getLocalMicrophoneStream()).toEqual({ id: "mic" });

    await facade.setMicrophoneEnabled(false);
    await facade.setCameraEnabled(true);
    await facade.setScreenShareEnabled(true);
    await facade.resumeAudioPlayback();
    await facade.disconnectFromRoom();

    expect(impl.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    expect(impl.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(impl.setScreenShareEnabled).toHaveBeenCalledWith(true);
    expect(impl.resumeAudioPlayback).toHaveBeenCalledTimes(1);
    expect(impl.disconnectFromRoom).toHaveBeenCalledTimes(1);

    // A second connect uses the caller's options untouched: no epoch is added.
    await facade.connectToRoom("wss://sfu", "token2");
    expect(impl.connectToRoom).toHaveBeenLastCalledWith("wss://sfu", "token2", {});
  });

  it("livekitPreload fetches the module ahead of a join", async () => {
    const { facade } = await freshFacade();

    facade.livekitPreload.preload();
    await facade.loadLivekit();

    expect(facade.isLivekitLoaded()).toBe(true);
    expect(impl.connectToRoom).not.toHaveBeenCalled();
    expect(facade.getLivekitRoom()).toBe(impl.room);
  });

  it("listeners registered before the SDK loads are the ones the room module notifies", async () => {
    const { facade } = await freshFacade();
    const events = await import("../roomEvents");

    const onConnected = vi.fn();
    const onTopology = vi.fn();
    const offRoom = facade.addRoomListener({ onParticipantConnected: onConnected });
    const offTopology = facade.onTrackTopologyChanged(onTopology);
    expect(facade.isLivekitLoaded()).toBe(false);

    // What livekitClient does when the room reports an event.
    for (const l of events.roomListeners) l.onParticipantConnected?.("alice");
    events.notifyTopology();
    expect(onConnected).toHaveBeenCalledWith("alice");
    expect(onTopology).toHaveBeenCalledTimes(1);

    offRoom();
    offTopology();
    for (const l of events.roomListeners) l.onParticipantConnected?.("bob");
    events.notifyTopology();
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onTopology).toHaveBeenCalledTimes(1);
  });
});
