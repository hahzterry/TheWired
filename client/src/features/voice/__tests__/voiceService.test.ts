/**
 * Voice-channel join under mandatory E2EE (docs/E2EE_CALLS.md):
 * unsupported WebView → blocked before any token; supported → the room is
 * joined with the channel key context; 409 E2EE_REQUIRED → readable error.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  e2eeSupported: true,
  connectRoom: vi.fn(async (_url: string, _token: string, _opts?: unknown) => ({})),
  fetchToken: vi.fn(async (_s: string, _c: string) => ({ token: "t", url: "wss://x", roomName: "s:c" })),
}));

vi.mock("@/lib/webrtc/e2ee/support", () => ({
  e2eeSupported: () => h.e2eeSupported,
  E2EEUnsupportedError: class E2EEUnsupportedError extends Error {
    constructor() {
      super("End-to-end encrypted calls aren't supported on this device");
      this.name = "E2EEUnsupportedError";
    }
  },
}));
vi.mock("@/lib/webrtc/livekit", () => ({
  connectToRoom: (...a: [string, string, unknown]) => h.connectRoom(...a),
  disconnectFromRoom: vi.fn(async () => {}),
  setMicrophoneEnabled: vi.fn(async () => {}),
  setCameraEnabled: vi.fn(async () => {}),
  setScreenShareEnabled: vi.fn(async () => {}),
}));
vi.mock("@/lib/webrtc/remoteAudio", () => ({ setRemoteAudioOutputMuted: vi.fn() }));
vi.mock("@/lib/api/voice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/voice")>()),
  fetchVoiceToken: (s: string, c: string) => h.fetchToken(s, c),
}));
vi.mock("@/lib/api/client", () => ({ api: vi.fn(async () => ({ data: {} })) }));
vi.mock("@/lib/nostr/roomPresence", () => ({
  publishRoomPresence: vi.fn(async () => {}),
  clearRoomPresence: vi.fn(async () => {}),
}));

import { joinVoiceChannel } from "../voiceService";
import { store, resetAll } from "@/store";
import { login } from "@/store/slices/identitySlice";
import { MediaEngineLoadError, MEDIA_ENGINE_LOAD_MESSAGE } from "@/lib/webrtc/loadError";

const ME = "f".repeat(64);

beforeEach(() => {
  store.dispatch(resetAll());
  store.dispatch(login({ pubkey: ME, signerType: "nip07" }));
  h.e2eeSupported = true;
  h.connectRoom.mockClear();
  h.fetchToken.mockClear();
});

describe("joinVoiceChannel", () => {
  it("joins with the channel E2EE context", async () => {
    await joinVoiceChannel("s", "c");
    expect(h.fetchToken).toHaveBeenCalledWith("s", "c");
    // `epoch` ties the join to the account that started it (account switch mid-join).
    expect(h.connectRoom).toHaveBeenCalledWith("wss://x", "t", {
      e2ee: { kind: "channel", roomName: "s:c" },
      epoch: expect.any(Number),
    });
    expect(store.getState().voice.connectedRoom).toEqual({ spaceId: "s", channelId: "c", roomName: "s:c" });
  });

  it("blocks an unsupported WebView before fetching a token", async () => {
    h.e2eeSupported = false;
    await expect(joinVoiceChannel("s", "c")).rejects.toThrow(/supported on this device/);
    expect(h.fetchToken).not.toHaveBeenCalled();
    expect(h.connectRoom).not.toHaveBeenCalled();
    expect(store.getState().voice.mediaError).toMatch(/end-to-end encrypted/i);
    expect(store.getState().voice.connecting).toBe(false);
  });

  it("maps the backend's E2EE_REQUIRED refusal to an update message", async () => {
    h.fetchToken.mockRejectedValueOnce(Object.assign(new Error("conflict"), { code: "E2EE_REQUIRED", status: 409 }));
    await expect(joinVoiceChannel("s", "c")).rejects.toThrow();
    expect(store.getState().voice.mediaError).toMatch(/Update The Wired/);
    expect(h.connectRoom).not.toHaveBeenCalled();
  });

  describe("when the voice code cannot be downloaded", () => {
    it("says so in plain words, with what to do, and never shows the engine's error", async () => {
      h.connectRoom.mockRejectedValueOnce(new MediaEngineLoadError(new TypeError("Importing a module script failed.")));

      await expect(joinVoiceChannel("s", "c")).rejects.toThrow();

      const shown = store.getState().voice.mediaError;
      expect(shown).toBe(MEDIA_ENGINE_LOAD_MESSAGE);
      expect(shown).toMatch(/check your connection/i);
      expect(shown).toMatch(/reload/i);
      expect(shown).not.toMatch(/Could not join|module/i);
      expect(store.getState().voice.connecting).toBe(false);
      expect(store.getState().voice.connectedRoom).toBeNull();
    });

    it("maps a raw failed-chunk error the same way, whichever engine worded it", async () => {
      for (const message of [
        "Failed to fetch dynamically imported module: https://app.example/assets/livekitClient-abc.js",
        "Importing a module script failed.",
        "error loading dynamically imported module",
      ]) {
        h.connectRoom.mockRejectedValueOnce(new TypeError(message));
        await expect(joinVoiceChannel("s", "c")).rejects.toThrow();
        expect(store.getState().voice.mediaError).toBe(MEDIA_ENGINE_LOAD_MESSAGE);
      }
    });

    it("a second attempt joins once the download works", async () => {
      h.connectRoom.mockRejectedValueOnce(new MediaEngineLoadError(new TypeError("Failed to fetch dynamically imported module")));
      await expect(joinVoiceChannel("s", "c")).rejects.toThrow();

      await joinVoiceChannel("s", "c");

      expect(h.connectRoom).toHaveBeenCalledTimes(2);
      expect(store.getState().voice.connectedRoom).toEqual({ spaceId: "s", channelId: "c", roomName: "s:c" });
      expect(store.getState().voice.mediaError).toBeNull();
    });
  });
});
