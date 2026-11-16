import { useEffect, type RefObject } from "react";
import { stripMediaGrant } from "@ishtarservices/core";
import { peekRetained, retain, useActiveAccount } from "@/hooks/useRetainedState";

/** Below this many seconds there is nothing worth coming back to. */
const MIN_POSITION_S = 1;
/** A position this close to the end starts over instead. */
const END_MARGIN_S = 1;

/**
 * Keeps an inline player's place while its element is not mounted.
 *
 * A card in a virtualized list is unmounted once it is well outside the
 * viewport, and its `<video>` or `<audio>` goes with it: playback stops, and
 * a fresh element would start again from zero. Stopping is deliberate (a
 * player nobody can see or reach should not keep playing); losing the place
 * is not. The position is remembered as playback advances and put back when
 * the same media is mounted again, paused, so pressing play carries on from
 * where it was.
 *
 * `key` identifies the media (its URL; a `?tk=` grant is ignored, since the
 * token rotates and the bytes don't). Positions are kept per account with the
 * other retained row state. Live streams have no position and are left alone.
 */
export function useResumePlayback(ref: RefObject<HTMLMediaElement | null>, key: string | null | undefined): void {
  const account = useActiveAccount();
  useEffect(() => {
    const el = ref.current;
    if (!el || !key) return;
    const slot = `media-position:${stripMediaGrant(key)}`;
    let played = false;

    const restore = () => {
      const at = peekRetained<number>(account, slot);
      if (at === undefined) return;
      if (Number.isFinite(el.duration) && at > el.duration - END_MARGIN_S) return;
      try {
        el.currentTime = at;
      } catch {
        /* not seekable yet: starts from the beginning */
      }
    };
    const remember = () => {
      if (!Number.isFinite(el.duration)) return;
      const at = el.currentTime;
      if (at >= MIN_POSITION_S) retain(account, slot, at);
      // Back at the start because the reader took it there, not because the
      // element was just created.
      else if (played) retain(account, slot, undefined);
    };
    const onPlay = () => {
      played = true;
    };
    const forget = () => retain(account, slot, undefined);

    if (el.readyState >= 1) restore();
    el.addEventListener("loadedmetadata", restore);
    el.addEventListener("timeupdate", remember);
    el.addEventListener("play", onPlay);
    el.addEventListener("ended", forget);
    return () => {
      el.removeEventListener("loadedmetadata", restore);
      el.removeEventListener("timeupdate", remember);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("ended", forget);
    };
  }, [ref, key, account]);
}
