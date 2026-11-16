import { describe, it, expect } from "vitest";
import { isMediaEngineLoadError, MediaEngineLoadError, MEDIA_ENGINE_LOAD_MESSAGE } from "../loadError";
import { describeMediaError } from "../mediaDevices";

describe("MediaEngineLoadError", () => {
  it("carries the user-facing sentence and keeps the engine's error as its cause", () => {
    const cause = new TypeError("Importing a module script failed.");
    const err = new MediaEngineLoadError(cause);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("MediaEngineLoadError");
    expect(err.message).toBe(MEDIA_ENGINE_LOAD_MESSAGE);
    expect(err.cause).toBe(cause);
  });

  it("the sentence says what to do and names no internals", () => {
    expect(MEDIA_ENGINE_LOAD_MESSAGE).toMatch(/check your connection/i);
    expect(MEDIA_ENGINE_LOAD_MESSAGE).toMatch(/try again/i);
    expect(MEDIA_ENGINE_LOAD_MESSAGE).toMatch(/reload/i);
    expect(MEDIA_ENGINE_LOAD_MESSAGE).not.toMatch(/module|chunk|import|livekit|sdk/i);
  });
});

describe("isMediaEngineLoadError", () => {
  it("recognises the wrapped error and each engine's raw failed-chunk error", () => {
    expect(isMediaEngineLoadError(new MediaEngineLoadError(null))).toBe(true);
    expect(isMediaEngineLoadError(new TypeError("Failed to fetch dynamically imported module: /assets/x.js"))).toBe(true);
    expect(isMediaEngineLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isMediaEngineLoadError(new TypeError("Importing a module script failed."))).toBe(true);
  });

  it("leaves real call and device errors alone", () => {
    expect(isMediaEngineLoadError(Object.assign(new Error("denied"), { name: "NotAllowedError" }))).toBe(false);
    expect(isMediaEngineLoadError(Object.assign(new Error("could not establish pc connection"), { name: "ConnectionError" }))).toBe(false);
    expect(isMediaEngineLoadError(new Error("Failed to fetch"))).toBe(false);
    expect(isMediaEngineLoadError(null)).toBe(false);
    expect(isMediaEngineLoadError("nope")).toBe(false);
  });
});

describe("describeMediaError", () => {
  it("does not blame the camera or microphone for code that did not download", () => {
    for (const kind of ["media", "microphone", "camera"] as const) {
      expect(describeMediaError(new MediaEngineLoadError(null), kind)).toBe(MEDIA_ENGINE_LOAD_MESSAGE);
      expect(describeMediaError(new TypeError("Failed to fetch dynamically imported module: /assets/x.js"), kind)).toBe(
        MEDIA_ENGINE_LOAD_MESSAGE,
      );
    }
  });

  it("still describes device errors as before", () => {
    expect(describeMediaError(Object.assign(new Error("x"), { name: "NotFoundError" }), "microphone")).toMatch(
      /No microphone found/,
    );
    expect(describeMediaError(new Error("boom"))).toBe("Could not access the camera or microphone: boom");
  });
});
