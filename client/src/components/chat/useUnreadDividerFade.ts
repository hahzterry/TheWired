import { useCallback, useEffect, useRef } from "react";

/** How long the "New messages" divider stays before it fades. */
export const UNREAD_DIVIDER_FADE_MS = 8_000;
/** The CSS fade itself, after which the divider is cleared. */
const FADE_TRANSITION_MS = 500;

/**
 * Owns the unread divider's lifetime for a virtualized message list.
 *
 * The divider used to time its own fade from the moment it mounted. In a
 * virtualized list its row unmounts when the reader scrolls away and would
 * start the countdown again on return, or never finish it. So the list keeps
 * the clock: `onFaded` fires once, a fixed time after the divider first
 * appeared for `resetKey`, and `remainingMs()` tells a (re)mounted divider row
 * how much of its visible time is left.
 */
export function useUnreadDividerFade(active: boolean, resetKey: string, onFaded: () => void) {
  const shownAt = useRef<number | null>(null);
  const onFadedRef = useRef(onFaded);
  onFadedRef.current = onFaded;

  useEffect(() => {
    if (!active) {
      shownAt.current = null;
      return;
    }
    shownAt.current = Date.now();
    const timer = setTimeout(() => onFadedRef.current(), UNREAD_DIVIDER_FADE_MS + FADE_TRANSITION_MS);
    return () => clearTimeout(timer);
  }, [active, resetKey]);

  /** Milliseconds until the divider should start fading (at least 1). */
  return useCallback(() => {
    if (shownAt.current === null) return UNREAD_DIVIDER_FADE_MS;
    return Math.max(1, UNREAD_DIVIDER_FADE_MS - (Date.now() - shownAt.current));
  }, []);
}
