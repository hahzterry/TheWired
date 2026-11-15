import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { markProgrammaticScroll } from "@/lib/virtual/viewportAnchor";

/**
 * Anchor-aware scroll restoration for feeds whose height grows *after* paint
 * (note media that doesn't reserve a box until it loads).
 *
 * A raw pixel offset is fragile here: on remount the cards render immediately
 * from Redux, but their images are 0px tall until they load, so `scrollHeight`
 * is a fraction of what it was when the offset was saved. Setting the saved
 * pixel offset clamps to the (short) max scroll → the feed "snaps to the top",
 * and late image loads above the fold shift everything underneath even after a
 * lucky restore.
 *
 * Instead we remember the *card* the viewport was sitting on (its id + the px
 * scrolled past its top) and, on restore, scroll so that same card lands in the
 * same place. Because we re-resolve the card's live position, growth elsewhere
 * can't drift it. We keep re-pinning for a short window as media loads, and bow
 * out the instant the user scrolls.
 *
 * Pixel offset is still stored and used as a fallback (anchor missing, or the
 * viewport was above the first card — e.g. in a profile header).
 *
 * Virtualized feeds: only the cards around the viewport are in the DOM, so the
 * saved anchor is usually not there to measure when the feed is reopened. The
 * caller passes `scrollToAnchor`, which asks the virtualizer to bring that card
 * in; once it is rendered the same re-pinning takes over. A pixel offset is
 * never applied while waiting, because the unmeasured list has no meaningful
 * pixel positions yet.
 */
/**
 * Stop re-pinning once the anchor target holds steady for this many frames
 * (about half a second). Long enough for cards above the anchor to finish
 * settling their media after a virtualized list has rendered them.
 */
const REPIN_STABLE_FRAMES = 30;

export interface SavedScrollPosition {
  scrollTop: number;
  anchorId?: string;
  anchorOffset?: number;
  /**
   * How tall the anchor card was when the position was saved. When the card
   * comes back at another height (the window or the column count changed),
   * the offset is scaled with it, so the reader lands on the same part of the
   * card instead of a pixel count that may now be past its end.
   */
  anchorHeight?: number;
}

export interface AnchoredScrollRestoreOptions {
  /** Identity of the current view; restoration re-runs when this changes. */
  key: string | null;
  /** Read the saved position for the current key (called at restore time). */
  read: () => SavedScrollPosition | undefined;
  /** Persist the current position for the current key. */
  write: (pos: SavedScrollPosition) => void;
  /**
   * Attribute on feed cards holding a stable id (e.g. `"data-feed-anchor"`).
   * When set, restoration pins to that card; omit for pixel-only behaviour.
   */
  cardAttr?: string;
  /** Disable save/restore (e.g. an inactive panel). Default true. */
  active?: boolean;
  /** How long to keep re-pinning the anchor as late media loads (ms). */
  repinDurationMs?: number;
  /**
   * Virtualized lists: bring a card that is not in the DOM into view, `offset`
   * px scrolled past its top. Return true once the request was made, false if
   * the list is not ready yet (it is asked again next frame), or null when the
   * card is not in the list any more (falls back to the pixel offset).
   */
  scrollToAnchor?: (anchorId: string, offset: number) => boolean | null;
}

/** Snapshot where the scroll container is sitting, as an anchor card + offset. */
export function captureScrollPosition(
  container: HTMLElement,
  cardAttr?: string,
): SavedScrollPosition {
  const scrollTop = container.scrollTop;
  if (!cardAttr) return { scrollTop };

  const cards = container.querySelectorAll<HTMLElement>(`[${cardAttr}]`);
  const containerTop = container.getBoundingClientRect().top;
  let anchor: { id: string; top: number; height: number } | null = null;

  // Cards are in document order: walk down until one starts below the fold top.
  // The last card starting at/above the fold top is the one the user is reading.
  for (const card of cards) {
    const id = card.getAttribute(cardAttr);
    if (!id) continue;
    const rect = card.getBoundingClientRect();
    const top = rect.top - containerTop + scrollTop;
    if (top <= scrollTop + 1) {
      anchor = { id, top, height: rect.height };
    } else {
      break;
    }
  }

  if (anchor) {
    const saved: SavedScrollPosition = { scrollTop, anchorId: anchor.id, anchorOffset: scrollTop - anchor.top };
    if (anchor.height > 0) saved.anchorHeight = anchor.height;
    return saved;
  }
  return { scrollTop };
}

/**
 * The scrollTop that puts the saved anchor card back where it was, or null
 * when that card is not in the DOM (no anchor saved, or not rendered).
 */
export function resolveAnchorTop(
  container: HTMLElement,
  saved: SavedScrollPosition,
  cardAttr?: string,
): number | null {
  if (!cardAttr || !saved.anchorId) return null;
  const el = container.querySelector<HTMLElement>(
    `[${cardAttr}="${CSS.escape(saved.anchorId)}"]`,
  );
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const top = rect.top - container.getBoundingClientRect().top + container.scrollTop;
  return Math.max(0, top + scaledAnchorOffset(saved, rect.height));
}

/**
 * The saved offset into the anchor card, scaled to the card's height now. A
 * card that kept its height (within a pixel) keeps the exact offset.
 */
export function scaledAnchorOffset(saved: SavedScrollPosition, heightNow: number): number {
  const offset = saved.anchorOffset ?? 0;
  const before = saved.anchorHeight;
  if (!before || before <= 0 || heightNow <= 0 || Math.abs(heightNow - before) <= 1) return offset;
  return offset * (heightNow / before);
}

/** Resolve the scrollTop that puts the saved anchor card back where it was. */
export function resolveScrollTop(
  container: HTMLElement,
  saved: SavedScrollPosition,
  cardAttr?: string,
): number {
  return resolveAnchorTop(container, saved, cardAttr) ?? saved.scrollTop;
}

/** How long each frame of the re-pin loop claims the scroller for. */
const REPIN_MARK_MS = 150;

/** Frames to wait for a requested card to render before asking again. */
const ANCHOR_REQUEST_FRAMES = 20;

export interface AnchoredScrollRestore {
  /** Attach to the scrollable container. */
  containerRef: (node: HTMLDivElement | null) => void;
  /** Snapshot the current position now (e.g. just before a tab switch). */
  capture: () => void;
}

export function useAnchoredScrollRestore({
  key,
  read,
  write,
  cardAttr,
  active = true,
  repinDurationMs = 3000,
  scrollToAnchor,
}: AnchoredScrollRestoreOptions): AnchoredScrollRestore {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  // Mutable mirrors so the listeners (attached once) always see fresh values.
  const readRef = useRef(read);
  const writeRef = useRef(write);
  const keyRef = useRef(key);
  const activeRef = useRef(active);
  const cardAttrRef = useRef(cardAttr);
  const scrollToAnchorRef = useRef(scrollToAnchor);
  scrollToAnchorRef.current = scrollToAnchor;
  readRef.current = read;
  writeRef.current = write;
  activeRef.current = active;
  cardAttrRef.current = cardAttr;

  const restoringRef = useRef(false);
  const saveRaf = useRef(0);
  const repinRaf = useRef(0);
  const restoredKeyRef = useRef<string | null>(null);

  const cancelRepin = useCallback(() => {
    if (repinRaf.current) {
      cancelAnimationFrame(repinRaf.current);
      repinRaf.current = 0;
    }
  }, []);

  const doRestore = useCallback(() => {
    const el = nodeRef.current;
    if (!el || !activeRef.current) return;
    restoredKeyRef.current = keyRef.current;

    const saved = readRef.current();
    // No remembered position (first visit / unvisited tab) → start at the top
    // rather than inheriting the previous view's offset.
    if (!saved || (saved.scrollTop <= 0 && !saved.anchorId)) {
      el.scrollTop = 0;
      return;
    }

    restoringRef.current = true;
    cancelRepin();
    // A virtualized list keeps the reader's place on its own while idle; tell
    // it this scrolling is ours, so it does not put the old position back. The
    // mark is renewed every frame of the loop below and lapses soon after it.
    markProgrammaticScroll(el, REPIN_MARK_MS);

    // A virtualized list may not have the anchor card rendered. Ask it to
    // bring the card in; never fall back to a pixel offset while waiting.
    // `requested` counts frames since the last request (-1: none yet).
    let requested = -1;
    let anchorGone = false;
    const viaList = (): boolean => {
      const ask = scrollToAnchorRef.current;
      if (!ask || !saved.anchorId || anchorGone) return false;
      if (requested < 0 || requested >= ANCHOR_REQUEST_FRAMES) {
        const result = ask(saved.anchorId, saved.anchorOffset ?? 0);
        if (result === null) {
          anchorGone = true;
          return false;
        }
        requested = result ? 0 : -1;
      } else {
        requested++;
      }
      return true;
    };

    // Apply immediately — pre-paint when invoked from a layout effect — so the
    // feed never flashes the top before jumping.
    const first = resolveAnchorTop(el, saved, cardAttrRef.current);
    if (first !== null) el.scrollTop = first;
    else if (!viaList()) el.scrollTop = saved.scrollTop;

    // Keep the anchor pinned while late media grows the content, then release.
    // Bail as soon as the target holds steady for a few frames (content settled)
    // instead of always burning the full window — most restores settle at once.
    let frames = 0;
    let stable = 0;
    const maxFrames = Math.max(1, Math.ceil(repinDurationMs / 16));
    const step = () => {
      const node = nodeRef.current;
      if (!node || !restoringRef.current) {
        repinRaf.current = 0;
        return;
      }
      const anchored = resolveAnchorTop(node, saved, cardAttrRef.current);
      if (anchored === null && viaList()) {
        // Waiting for the list to render the card.
        stable = 0;
      } else {
        const target = anchored ?? saved.scrollTop;
        if (Math.abs(node.scrollTop - target) > 1) {
          node.scrollTop = target;
          stable = 0;
        } else {
          stable++;
        }
      }
      if (stable >= REPIN_STABLE_FRAMES || ++frames >= maxFrames) {
        restoringRef.current = false;
        repinRaf.current = 0;
        return;
      }
      markProgrammaticScroll(node, REPIN_MARK_MS);
      repinRaf.current = requestAnimationFrame(step);
    };
    repinRaf.current = requestAnimationFrame(step);
  }, [cancelRepin, repinDurationMs]);

  // Persist the position on scroll (rAF-throttled, ignored during restore).
  const onScroll = useCallback(() => {
    if (restoringRef.current || !activeRef.current || saveRaf.current) return;
    saveRaf.current = requestAnimationFrame(() => {
      saveRaf.current = 0;
      const el = nodeRef.current;
      if (el) writeRef.current(captureScrollPosition(el, cardAttrRef.current));
    });
  }, []);

  // A real user gesture ends the restore window so we stop fighting the user.
  // (Programmatic scrollTop fires "scroll" but not wheel/touch/key, so these
  // are clean signals of intent.)
  const onUserInput = useCallback(() => {
    restoringRef.current = false;
    cancelRepin();
  }, [cancelRepin]);

  // Callback ref: (re)wires listeners and restores when the container attaches —
  // including the case where it appears only after a loading spinner clears.
  const containerRef = useCallback(
    (node: HTMLDivElement | null) => {
      const prev = nodeRef.current;
      if (prev) {
        prev.removeEventListener("scroll", onScroll);
        prev.removeEventListener("wheel", onUserInput);
        prev.removeEventListener("touchstart", onUserInput);
        prev.removeEventListener("keydown", onUserInput);
      }
      nodeRef.current = node;
      if (!node) return;
      node.addEventListener("scroll", onScroll, { passive: true });
      node.addEventListener("wheel", onUserInput, { passive: true });
      node.addEventListener("touchstart", onUserInput, { passive: true });
      node.addEventListener("keydown", onUserInput);
      if (restoredKeyRef.current !== keyRef.current) doRestore();
    },
    [onScroll, onUserInput, doRestore],
  );

  const capture = useCallback(() => {
    const el = nodeRef.current;
    if (el && activeRef.current) {
      writeRef.current(captureScrollPosition(el, cardAttrRef.current));
    }
  }, []);

  // Restore on key change when the same container node persists (e.g. a tab
  // switch within the page). Fresh mounts go through the callback ref above.
  useLayoutEffect(() => {
    keyRef.current = key;
    if (!active) return;
    // Drop a pending save so it can't overwrite the new key with stale content.
    if (saveRaf.current) {
      cancelAnimationFrame(saveRaf.current);
      saveRaf.current = 0;
    }
    if (nodeRef.current && restoredKeyRef.current !== key) doRestore();
  }, [key, active, doRestore]);

  useEffect(() => {
    // In development React runs every effect's cleanup once right after mount
    // (StrictMode). That cleanup cancels a re-pin loop the container ref has
    // just started, which left a fresh mount without its re-pinning. Resume it.
    if (restoringRef.current && !repinRaf.current && nodeRef.current) doRestore();
    return () => {
      if (saveRaf.current) cancelAnimationFrame(saveRaf.current);
      cancelRepin();
    };
  }, [cancelRepin, doRestore]);

  return { containerRef, capture };
}
