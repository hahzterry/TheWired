/**
 * hls.js could not be downloaded. Every player (video and audio) takes the
 * library from `loadHls`, so this is the one failure-and-retry path.
 */
import { describe, it, expect, vi } from "vitest";

const hls = vi.hoisted(() => ({ offline: true, imports: 0, sources: [] as string[] }));

vi.mock("hls.js", () => {
  hls.imports += 1;
  if (hls.offline) throw new TypeError("Failed to fetch dynamically imported module: /assets/hls-abc.js");
  class FakeHls {
    static Events = { ERROR: "hlsError" };
    static isSupported() {
      return true;
    }
    loadSource(src: string) {
      hls.sources.push(src);
    }
    attachMedia() {}
    destroy() {}
    on() {}
  }
  return { default: FakeHls };
});

import { attachVideoSource, loadHls } from "../hls";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// In this order: once the library has loaded it stays loaded.
describe("hls.js that cannot be downloaded", () => {
  it("loadHls rejects, and a video falls back to handing the manifest to the element", async () => {
    await expect(loadHls()).rejects.toThrow();

    const video = document.createElement("video");
    attachVideoSource(video, "https://cdn.example/live.m3u8", { isHls: true });
    await flush();

    expect(video.src).toBe("https://cdn.example/live.m3u8");
    expect(hls.sources).toEqual([]);
  });

  it("the failure is not kept: each new request downloads again", async () => {
    const before = hls.imports;
    await expect(loadHls()).rejects.toThrow();
    await expect(loadHls()).rejects.toThrow();
    expect(hls.imports).toBe(before + 2);
  });

  it("once the download works, the same loader hands out the library and players attach through it", async () => {
    hls.offline = false;

    const Hls = await loadHls();
    expect(Hls.isSupported()).toBe(true);

    const video = document.createElement("video");
    attachVideoSource(video, "https://cdn.example/live.m3u8", { isHls: true });
    await flush();
    expect(hls.sources).toEqual(["https://cdn.example/live.m3u8"]);
    expect(video.getAttribute("src")).toBeNull();

    // Loaded for good now: no further imports.
    const settled = hls.imports;
    await loadHls();
    expect(hls.imports).toBe(settled);
  });
});
