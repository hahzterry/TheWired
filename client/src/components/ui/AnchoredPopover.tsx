import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { focusableWithin, useEscapeLayer } from "./layer";

/**
 * Chrome-less anchored popup for self-styled panels (GIF/emoji pickers, poll
 * composer, autocompletes). Renders via portal with fixed positioning so it can
 * never be clipped by an `overflow` container.
 *
 * Crucially it is *space-aware*: it picks the side (above/below) with room,
 * then caps the panel to the space actually available there and exposes that
 * cap as `--popover-max-h` / `--popover-max-w` CSS variables. Panels read those
 * vars (e.g. `max-h-[var(--popover-max-h,420px)]`) and scroll internally, so a
 * 435px picker in a 300px gap shrinks-and-scrolls instead of overflowing the
 * viewport. Positioning alone is not enough — clamping a fixed-height panel
 * just pushes the overflow off the opposite edge.
 *
 * Distinct from `PopoverMenu`, which is a styled menu (card chrome, focus
 * roving). This one only solves placement + sizing, and closes on Escape /
 * outside click / outside scroll, re-measuring on lazy content resize.
 *
 * Keyboard: the popup is portaled to the end of <body>, far from its trigger
 * in tab order. So when it is opened from the keyboard on a button-like
 * trigger, focus moves into it; Tab past either end closes it and returns to
 * the trigger; and closing it while it holds focus puts focus back on the
 * trigger. Popups anchored to a text field (autocompletes) never take focus:
 * the user keeps typing.
 */

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface AnchoredPosition {
  placedBelow: boolean;
  /** px from viewport top — set when placedBelow. */
  top: number | null;
  /** px from viewport bottom — set when placed above. */
  bottom: number | null;
  left: number;
  maxHeight: number;
  maxWidth: number;
}

/**
 * Pure placement + sizing. Prefers `preferredSide`; flips when it doesn't fit;
 * when neither side fits the panel it takes the roomier side. `maxHeight`/
 * `maxWidth` are the space available on the chosen side so the caller can cap
 * the panel and let it scroll internally rather than overflow.
 */
export function computeAnchoredPosition(
  anchor: Rect,
  popup: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: { gap?: number; margin?: number; preferredSide?: "above" | "below" } = {},
): AnchoredPosition {
  const { gap = 6, margin = 8, preferredSide = "below" } = opts;

  const spaceBelow = viewport.height - anchor.bottom - gap - margin;
  const spaceAbove = anchor.top - gap - margin;
  const fitsBelow = popup.height <= spaceBelow;
  const fitsAbove = popup.height <= spaceAbove;

  // Stay on the preferred side when it fits; otherwise take whichever side has
  // more room. (When the preferred side is "below", ties go below.)
  const placedBelow =
    preferredSide === "below"
      ? fitsBelow || spaceBelow >= spaceAbove
      : !(fitsAbove || spaceAbove > spaceBelow);

  const maxWidth = Math.max(0, viewport.width - 2 * margin);
  const width = Math.min(popup.width, maxWidth);
  const left = Math.max(
    margin,
    Math.min(anchor.left, viewport.width - width - margin),
  );

  if (placedBelow) {
    return {
      placedBelow: true,
      top: anchor.bottom + gap,
      bottom: null,
      left,
      maxHeight: Math.max(0, spaceBelow),
      maxWidth,
    };
  }
  return {
    placedBelow: false,
    top: null,
    // Distance from viewport bottom so the panel grows upward from the anchor.
    bottom: viewport.height - anchor.top + gap,
    left,
    maxHeight: Math.max(0, spaceAbove),
    maxWidth,
  };
}

interface AnchoredPopoverProps {
  /** Element the popup attaches to (trigger button, textarea, …). */
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Preferred vertical side; flips automatically when it doesn't fit. */
  preferredSide?: "above" | "below";
  /** Accessible name for the popup (e.g. "Emoji picker"). */
  label?: string;
  /** ARIA role for the popup container, when its content warrants one. */
  role?: "dialog" | "listbox" | "menu" | "group";
}

function isTextEntry(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

/** The trigger has keyboard focus (a mouse click leaves no :focus-visible). */
function hasKeyboardFocus(el: HTMLElement): boolean {
  if (document.activeElement !== el) return false;
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

export function AnchoredPopover({
  anchorEl,
  open,
  onClose,
  children,
  preferredSide = "below",
  label,
  role,
}: AnchoredPopoverProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  // Whether focus is (or was last) inside the popup — read when it closes.
  const heldFocus = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;
  const [coords, setCoords] = useState<AnchoredPosition | null>(null);

  const updatePosition = useCallback(() => {
    if (!anchorEl || !popupRef.current) return;
    const a = anchorEl.getBoundingClientRect();
    const p = popupRef.current.getBoundingClientRect();
    setCoords(
      computeAnchoredPosition(
        a,
        { width: p.width, height: p.height },
        { width: window.innerWidth, height: window.innerHeight },
        { preferredSide },
      ),
    );
  }, [anchorEl, preferredSide]);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    updatePosition();
  }, [open, updatePosition]);

  // Lazy-loaded content (Suspense fallback → real picker) and internal
  // shrink-to-cap both change the popup size — re-measure so placement stays
  // correct. Capping is convergent: once a panel is capped to the chosen
  // side's space it fits there, so the side never flips back and forth.
  useEffect(() => {
    if (!open || !popupRef.current) return;
    const ro = new ResizeObserver(() => updatePosition());
    ro.observe(popupRef.current);
    return () => ro.disconnect();
  }, [open, updatePosition]);

  // Escape closes this popup only, not the dialog it was opened from.
  useEscapeLayer(open, onClose);

  // Focus: move in when opened from the keyboard, hand back on close.
  useEffect(() => {
    const popup = popupRef.current;
    if (!open || !anchorEl || !popup) return;
    heldFocus.current = false;

    const onFocusIn = () => {
      heldFocus.current = true;
    };
    const onFocusOut = (e: FocusEvent) => {
      // Focus moved somewhere deliberate (not just dropped): leave it there.
      if (e.relatedTarget && !popup.contains(e.relatedTarget as Node)) heldFocus.current = false;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusableWithin(popup);
      if (items.length === 0) return;
      const active = document.activeElement;
      const leavingBackward = e.shiftKey && (active === items[0] || active === popup);
      const leavingForward = !e.shiftKey && active === items[items.length - 1];
      if (leavingBackward || leavingForward) {
        e.preventDefault();
        close.current();
      }
    };
    popup.addEventListener("focusin", onFocusIn);
    popup.addEventListener("focusout", onFocusOut);
    popup.addEventListener("keydown", onKeyDown);

    if (!isTextEntry(anchorEl) && hasKeyboardFocus(anchorEl)) popup.focus({ preventScroll: true });

    return () => {
      popup.removeEventListener("focusin", onFocusIn);
      popup.removeEventListener("focusout", onFocusOut);
      popup.removeEventListener("keydown", onKeyDown);
      const dropped = !document.activeElement || document.activeElement === document.body;
      const stillInside = popup.contains(document.activeElement);
      if (heldFocus.current && (dropped || stillInside) && document.contains(anchorEl)) {
        anchorEl.focus();
      }
      heldFocus.current = false;
    };
  }, [open, anchorEl]);

  // Outside click closes; clicks on the anchor are left to the trigger's own
  // toggle handler (otherwise close + re-open would race on the same click).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popupRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, onClose, anchorEl]);

  // Outside scroll makes the fixed coords stale → close (scrolling INSIDE the
  // popup, e.g. GIF results, must not dismiss it). Resize just repositions.
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      const target = e.target as Node | null;
      if (target && popupRef.current?.contains(target)) return;
      onClose();
    };
    const onResize = () => updatePosition();
    window.addEventListener("scroll", onScroll, { capture: true });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
    };
  }, [open, onClose, updatePosition]);

  if (!open || !anchorEl) return null;

  // Off-screen until the first measurement lands — avoids a placement flash.
  const style: CSSProperties = coords
    ? {
        left: coords.left,
        maxWidth: coords.maxWidth,
        maxHeight: coords.maxHeight,
        // Inherited by the panel so it can cap itself and scroll internally.
        ["--popover-max-h" as string]: `${coords.maxHeight}px`,
        ["--popover-max-w" as string]: `${coords.maxWidth}px`,
        ...(coords.placedBelow ? { top: coords.top! } : { bottom: coords.bottom! }),
      }
    : { top: -9999, left: -9999 };

  return createPortal(
    <div
      ref={popupRef}
      role={role}
      aria-label={label}
      tabIndex={-1}
      className="fixed z-50 flex flex-col outline-none"
      style={style}
    >
      {children}
    </div>,
    document.body,
  );
}
