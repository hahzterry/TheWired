/**
 * hls.js, loaded on demand.
 *
 * The library is about half a megabyte minified and only matters when an HLS
 * (`.m3u8`) source is actually played somewhere without native support, so it
 * must never be a static import. This is the only module that imports it:
 * video components attach a source through `attachVideoSource`, and the audio
 * player takes the constructor from `loadHls`. A download that fails is not
 * kept, so the next source that needs the library fetches it again.
 */
import type Hls from "hls.js";
import { preloadable } from "@/lib/lazyPreload";

const loadHlsModule = preloadable(() => import("hls.js"));

/** The hls.js constructor. One shared import however many players ask. */
export async function loadHls(): Promise<typeof Hls> {
  return (await loadHlsModule()).default;
}

export interface AttachVideoSourceOptions {
  /** Whether `src` is an HLS manifest. Each player keeps its own detection. */
  isHls: boolean;
  /** Called when hls.js reports an error it cannot recover from. */
  onFatalError?: () => void;
}

/**
 * Point `video` at `src`. A plain file is assigned directly. An HLS manifest
 * goes through hls.js where Media Source Extensions are available, and is
 * handed to the element otherwise (WebKit plays HLS natively). Returns a
 * cleanup that also cancels an attach still waiting for the library.
 *
 * For a manifest the source is attached once the library has arrived, not
 * before this returns. A `play()` issued in between is not lost: the element
 * has no source yet, so it stays in its "playing requested" state and starts
 * when the source is attached (checked in Chromium and WebKit). What does
 * differ is the promise that `play()` returned: Chromium resolves it when
 * playback starts, WebKit rejects it with AbortError at the moment the source
 * is assigned and plays anyway. Callers must not leave that promise unhandled.
 */
export function attachVideoSource(
  video: HTMLVideoElement,
  src: string,
  { isHls, onFatalError }: AttachVideoSourceOptions,
): () => void {
  if (!isHls) {
    video.src = src;
    return () => {};
  }

  let cancelled = false;
  let hls: Hls | null = null;

  loadHls().then(
    (HlsCtor) => {
      if (cancelled) return;
      if (!HlsCtor.isSupported()) {
        video.src = src;
        return;
      }
      hls = new HlsCtor({ enableWorker: true, lowLatencyMode: false });
      if (onFatalError) {
        hls.on(HlsCtor.Events.ERROR, (_event, data) => {
          if (data.fatal) onFatalError();
        });
      }
      hls.loadSource(src);
      hls.attachMedia(video);
    },
    () => {
      // The library could not be fetched. Let the element try: it plays where
      // HLS is native, and elsewhere raises the normal media error.
      if (!cancelled) video.src = src;
    },
  );

  return () => {
    cancelled = true;
    hls?.destroy();
    hls = null;
  };
}
