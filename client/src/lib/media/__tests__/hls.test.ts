import { describe, it, expect, beforeEach, vi } from "vitest";

/** A stand-in for the hls.js default export that records what was done to it. */
const hls = vi.hoisted(() => {
  const state = {
    supported: true,
    imports: 0,
    instances: [] as Array<{
      loadSource: ReturnType<typeof vi.fn>;
      attachMedia: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
      handlers: Record<string, (event: string, data: { fatal: boolean }) => void>;
    }>,
  };
  class FakeHls {
    static Events = { ERROR: "hlsError" };
    static isSupported() {
      return state.supported;
    }
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();
    handlers: Record<string, (event: string, data: { fatal: boolean }) => void> = {};
    constructor() {
      state.instances.push(this);
    }
    on(event: string, fn: (event: string, data: { fatal: boolean }) => void) {
      this.handlers[event] = fn;
    }
  }
  return { state, FakeHls };
});

vi.mock("hls.js", () => {
  hls.state.imports += 1;
  return { default: hls.FakeHls };
});

import { attachVideoSource, loadHls } from "../hls";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("attachVideoSource", () => {
  let video: HTMLVideoElement;

  beforeEach(() => {
    video = document.createElement("video");
    hls.state.supported = true;
    hls.state.instances.length = 0;
  });

  it("assigns a plain file directly and never touches hls.js", async () => {
    const cleanup = attachVideoSource(video, "https://cdn.example/clip.mp4", { isHls: false });
    await flush();

    expect(video.src).toBe("https://cdn.example/clip.mp4");
    expect(hls.state.instances).toHaveLength(0);
    expect(() => cleanup()).not.toThrow();
  });

  it("attaches hls.js for a manifest where MSE is supported", async () => {
    attachVideoSource(video, "https://cdn.example/live.m3u8", { isHls: true });
    await flush();

    expect(hls.state.instances).toHaveLength(1);
    expect(hls.state.instances[0].loadSource).toHaveBeenCalledWith("https://cdn.example/live.m3u8");
    expect(hls.state.instances[0].attachMedia).toHaveBeenCalledWith(video);
    expect(video.getAttribute("src")).toBeNull();
  });

  it("hands the manifest to the element where MSE is not supported (native HLS)", async () => {
    hls.state.supported = false;
    attachVideoSource(video, "https://cdn.example/live.m3u8", { isHls: true });
    await flush();

    expect(hls.state.instances).toHaveLength(0);
    expect(video.src).toBe("https://cdn.example/live.m3u8");
  });

  it("cleanup before the library arrives cancels the attach", async () => {
    const cleanup = attachVideoSource(video, "https://cdn.example/live.m3u8", { isHls: true });
    cleanup();
    await flush();

    expect(hls.state.instances).toHaveLength(0);
    expect(video.getAttribute("src")).toBeNull();
  });

  it("cleanup after attach destroys the instance", async () => {
    const cleanup = attachVideoSource(video, "https://cdn.example/live.m3u8", { isHls: true });
    await flush();
    cleanup();

    expect(hls.state.instances[0].destroy).toHaveBeenCalledTimes(1);
  });

  it("reports only fatal hls.js errors", async () => {
    const onFatalError = vi.fn();
    attachVideoSource(video, "https://cdn.example/live.m3u8", { isHls: true, onFatalError });
    await flush();

    const onError = hls.state.instances[0].handlers.hlsError;
    onError("hlsError", { fatal: false });
    expect(onFatalError).not.toHaveBeenCalled();
    onError("hlsError", { fatal: true });
    expect(onFatalError).toHaveBeenCalledTimes(1);
  });

  it("imports the library once however many players ask", async () => {
    const before = hls.state.imports;
    await Promise.all([loadHls(), loadHls(), loadHls()]);
    attachVideoSource(video, "a.m3u8", { isHls: true });
    attachVideoSource(document.createElement("video"), "b.m3u8", { isHls: true });
    await flush();

    expect(hls.state.imports - before).toBeLessThanOrEqual(1);
    expect(hls.state.instances).toHaveLength(2);
  });
});
