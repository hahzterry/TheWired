import { useEffect, useRef } from "react";
import { attachVideoSource } from "@/lib/media/hls";

interface VideoPlayerProps {
  src: string;
  poster?: string;
  className?: string;
}

export function VideoPlayer({ src, poster, className }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    const isHls =
      src.endsWith(".m3u8") ||
      src.includes("m3u8");

    // hls.js where it is needed, the element itself for MP4/WebM and native HLS.
    return attachVideoSource(video, src, { isHls });
  }, [src]);

  return (
    <video
      ref={videoRef}
      poster={poster}
      controls
      playsInline
      className={className ?? "h-full w-full rounded-lg bg-black"}
    />
  );
}
