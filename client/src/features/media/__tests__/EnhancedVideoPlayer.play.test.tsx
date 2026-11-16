/**
 * The play button and a source that is not attached yet.
 *
 * An HLS source is attached once its player library has downloaded. In that
 * window the element has no source: `play()` is honoured later, but WebKit
 * rejects the promise it returned (AbortError) when the source is assigned.
 * The player must not leave that rejection unhandled.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";

const hls = vi.hoisted(() => ({
  /** Resolved by the test to let the "library" arrive. */
  arrive: null as null | (() => void),
  attached: [] as string[],
}));

vi.mock("hls.js", async () => {
  // The import stays pending until the test releases it: the download window.
  await new Promise<void>((resolve) => {
    hls.arrive = resolve;
  });
  class FakeHls {
    static Events = { ERROR: "hlsError" };
    static isSupported() {
      return true;
    }
    loadSource(src: string) {
      hls.attached.push(src);
    }
    attachMedia() {}
    destroy() {}
    on() {}
  }
  return { default: FakeHls };
});

import { EnhancedVideoPlayer } from "../EnhancedVideoPlayer";


describe("EnhancedVideoPlayer play before the source is attached", () => {
  /** Rejection handlers attached to the promises play() returned. */
  let rejectionHandlers: number;
  let paused: boolean;
  let playCalls: number;
  const realPlay = HTMLMediaElement.prototype.play;

  beforeEach(() => {
    playCalls = 0;
    rejectionHandlers = 0;
    paused = true;
    hls.attached.length = 0;
    Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get: () => paused });
    // A plain function, not vi.fn: a mock attaches its own handlers to a
    // promise it returns (to record how it settled), which would hide a
    // caller that attaches none.
    HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
      playCalls += 1;
      paused = false;
      // What WebKit does: the promise is rejected once a source is assigned.
      const promise: Promise<void> = Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
      const then = promise.then.bind(promise) as (onFulfilled?: unknown, onRejected?: unknown) => Promise<unknown>;
      (promise as { then: unknown }).then = (onFulfilled?: unknown, onRejected?: unknown) => {
        if (typeof onRejected === "function") rejectionHandlers += 1;
        return then(onFulfilled, onRejected);
      };
      this.dispatchEvent(new Event("play"));
      return promise;
    };
    HTMLMediaElement.prototype.pause = vi.fn(function pause(this: HTMLMediaElement) {
      paused = true;
      this.dispatchEvent(new Event("pause"));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    HTMLMediaElement.prototype.play = realPlay;
    delete (HTMLMediaElement.prototype as { paused?: unknown }).paused;
  });

  it("handles the rejected play() promise, keeps the play request, and attaches the source when the library arrives", async () => {
    const { container } = render(<EnhancedVideoPlayer src="https://cdn.example/stream/master.m3u8" />);
    const video = container.querySelector("video")!;

    // The library has not arrived: nothing is attached yet.
    expect(hls.attached).toEqual([]);

    await act(async () => {
      fireEvent.click(video);
    });

    expect(playCalls).toBe(1);
    // A rejection handler was attached to the promise play() returned.
    expect(rejectionHandlers).toBeGreaterThan(0);
    // (An unhandled rejection would also fail the run: vitest reports them.)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The player shows "playing": it follows the element, which kept the request.
    expect(video.paused).toBe(false);

    // The library arrives and the source is attached, without a second play().
    await act(async () => {
      hls.arrive?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(hls.attached).toEqual(["https://cdn.example/stream/master.m3u8"]);
    expect(playCalls).toBe(1);
  });

  it("tolerates an engine whose play() returns nothing", async () => {
    HTMLMediaElement.prototype.play = function play() {
      playCalls += 1;
      return undefined as unknown as Promise<void>;
    };
    const { container } = render(<EnhancedVideoPlayer src="https://cdn.example/clip.mp4" />);

    expect(() => fireEvent.click(container.querySelector("video")!)).not.toThrow();
    expect(playCalls).toBe(1);
  });
});
