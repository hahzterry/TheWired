import { useCallback, useEffect, useRef } from "react";
import { ViewportAnchor } from "@/lib/virtual/viewportAnchor";
import { onVirtualizerScroll } from "@/lib/virtual/virtualizerScrolls";

/**
 * Keep the reader's place in a virtualized list while it is at rest (see
 * `ViewportAnchor`). `scroller` is the scrolling element and `list` the element
 * whose children are the rendered rows; nothing happens until both exist.
 *
 * Returns `expectShift`: call it when rows are added above the viewport, so
 * the scroll that makes room for them is not taken for a new place.
 */
export function useViewportAnchor(
  scroller: HTMLElement | null,
  list: HTMLElement | null,
  isPinned?: () => boolean,
): () => void {
  const keeperRef = useRef<ViewportAnchor | null>(null);
  useEffect(() => {
    if (!scroller || !list) return;
    const keeper = new ViewportAnchor({ scroller, list, isPinned });
    keeperRef.current = keeper;
    const onScroll = () => keeper.onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    // The virtualizer's own corrections (never its jumps, which use
    // `scrollTo`): the keeper answers them as they happen.
    const stopListening = onVirtualizerScroll(scroller, (delta, method) => {
      if (method === "scrollBy" && delta !== 0) keeper.onVirtualizerScroll();
    });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => keeper.onResize());
      observer.observe(list);
      observer.observe(scroller);
    }
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      stopListening();
      observer?.disconnect();
      keeper.dispose();
      if (keeperRef.current === keeper) keeperRef.current = null;
    };
    // `isPinned` reads a ref; its identity does not matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroller, list]);

  return useCallback(() => keeperRef.current?.expectShift(), []);
}
