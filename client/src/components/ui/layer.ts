import { useEffect, useRef, type RefObject } from "react";

/**
 * Shared keyboard plumbing for the overlay primitives (Modal, MediaLightbox,
 * PopoverMenu, AnchoredPopover).
 *
 * Open overlays form a stack. Escape goes to the top one only, so a menu or
 * confirm dialog opened from inside a modal closes by itself instead of taking
 * the modal with it.
 */

export const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function focusableWithin(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest("[inert]"),
  );
}

const layers: symbol[] = [];
const always = () => true;

function isTopLayer(id: symbol): boolean {
  return layers[layers.length - 1] === id;
}

/**
 * Register an overlay while `active` and call `onEscape` when Escape is
 * pressed and this overlay is the top one. Returns a ref-stable check for
 * "am I the top layer", used by the focus trap.
 */
export function useEscapeLayer(active: boolean, onEscape: () => void): () => boolean {
  const handler = useRef(onEscape);
  handler.current = onEscape;
  const id = useRef<symbol | null>(null);

  useEffect(() => {
    if (!active) return;
    const layer = Symbol("layer");
    id.current = layer;
    layers.push(layer);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopLayer(layer)) handler.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const at = layers.indexOf(layer);
      if (at !== -1) layers.splice(at, 1);
      id.current = null;
    };
  }, [active]);

  return useRef(() => id.current !== null && isTopLayer(id.current)).current;
}

/**
 * Modal focus handling for a dialog container: while `active`, move focus
 * inside (leaving a child's own autoFocus alone), keep Tab inside, and put
 * focus back on the element that had it before once the dialog goes away.
 *
 * `isTop` (from useEscapeLayer) gates the recovery path: if focus fell back to
 * <body> (the focused control was removed), the next Tab re-enters the dialog,
 * but only when no other overlay is stacked above it.
 */
export function useModalFocus(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  isTop: () => boolean = always,
): void {
  // Who to give focus back to. Two moments matter:
  //  - during render, before the dialog mounts: the only time the opener is
  //    still focused when a child of the dialog uses autoFocus;
  //  - when the effect runs: by then a menu that launched the dialog has closed
  //    and handed focus to its own trigger, which is where focus should return
  //    (the menu item itself is inert by now).
  const focusedAtRender = useRef<HTMLElement | null>(null);
  const wasActive = useRef(false);
  if (active && !wasActive.current) {
    focusedAtRender.current = document.activeElement as HTMLElement | null;
  }
  wasActive.current = active;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    const focusedNow = document.activeElement as HTMLElement | null;
    const previouslyFocused = container?.contains(focusedNow) ? focusedAtRender.current : focusedNow;

    if (container && !container.contains(document.activeElement)) {
      (focusableWithin(container)[0] ?? container).focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !container) return;
      const active = document.activeElement;
      const inside = container.contains(active);
      const lost = active === document.body || active === null;
      if (!inside && !(lost && isTop())) return;

      const items = focusableWithin(container);
      if (items.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (lost) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === container)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Restore focus to the element that opened the dialog (if still in the DOM).
      if (
        previouslyFocused &&
        document.contains(previouslyFocused) &&
        !previouslyFocused.closest("[inert]")
      ) {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef, isTop]);
}
