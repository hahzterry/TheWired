import { useRef } from "react";
import { useResumePlayback } from "./useResumePlayback";

/**
 * A native audio player for audio attached to a note or message. Remembers
 * its position while the row it sits in is scrolled out of a virtualized
 * list (see `useResumePlayback`).
 */
export function InlineAudio({ src, className }: { src: string; className?: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  useResumePlayback(ref, src);
  return <audio ref={ref} src={src} controls preload="metadata" className={className} />;
}
