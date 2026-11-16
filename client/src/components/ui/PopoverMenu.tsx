import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useClickOutside } from "../../hooks/useClickOutside";
import { focusableWithin, useEscapeLayer } from "./layer";

interface PopoverMenuProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  position?: "above" | "below";
  /** When provided, renders via portal with fixed positioning anchored to this element */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Accessible name for the popup (e.g. "Message actions"). */
  label?: string;
}

/** True inside a PopoverMenu that is a real menu (items and separators only). */
const MenuRoleContext = createContext(false);

/**
 * A popup made of nothing but PopoverMenuItem / PopoverMenuSeparator is an
 * ARIA menu. Anything else (a slider, a text field, a custom list) is left as
 * a plain container: `role="menu"` forbids those children.
 */
function isItemsOnly(children: ReactNode): boolean {
  let items = 0;
  const walk = (nodes: ReactNode): boolean =>
    Children.toArray(nodes).every((child) => {
      if (!isValidElement(child)) return false;
      if (child.type === Fragment) return walk((child.props as { children?: ReactNode }).children);
      if (child.type === PopoverMenuItem) {
        items += 1;
        return true;
      }
      return child.type === PopoverMenuSeparator;
    });
  return walk(children) && items > 0;
}

export function PopoverMenu({ open, onClose, children, position = "above", anchorRef, label }: PopoverMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<React.CSSProperties>({});
  const usePortal = !!anchorRef;
  const isMenu = isItemsOnly(children);
  useClickOutside(ref, onClose, open);
  // Escape closes this popup only, not the dialog it was opened from.
  useEscapeLayer(open, onClose);

  // Keyboard a11y: move focus into the menu on open, let Up/Down/Home/End rove
  // its items, and restore focus to the opener on close. Arrow keys are ignored
  // while focus is in a text field so the caret still works.
  useEffect(() => {
    if (!open) return;
    const menu = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const items = () => focusableWithin(menu);

    const raf = window.requestAnimationFrame(() => {
      if (menu && !menu.contains(document.activeElement)) {
        (items()[0] ?? menu).focus();
      }
    });

    const onKey = (e: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      const list = items();
      if (list.length === 0) return;
      e.preventDefault();
      const cur = list.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? list.length - 1
            : e.key === "ArrowDown"
              ? cur < 0
                ? 0
                : (cur + 1) % list.length
              : cur < 0
                ? list.length - 1
                : (cur - 1 + list.length) % list.length;
      list[next].focus();
    };

    menu?.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(raf);
      menu?.removeEventListener("keydown", onKey);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  // Compute fixed position from anchor element when using portal mode.
  // Measures the menu after render and flips above/below if it would overflow.
  useLayoutEffect(() => {
    if (!usePortal || !open || !anchorRef?.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const menuHeight = ref.current?.offsetHeight ?? 300;
    const gap = 4;
    const style: React.CSSProperties = {};

    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;

    const preferBelow = position === "below";
    const fitsBelow = menuHeight <= spaceBelow;
    const fitsAbove = menuHeight <= spaceAbove;

    // Place below if preferred and fits, or if above doesn't fit either but below has more room
    const placeBelow = preferBelow
      ? (fitsBelow || !fitsAbove)
      : (!fitsAbove && fitsBelow);

    if (placeBelow) {
      // Clamp so menu doesn't overflow bottom
      const top = rect.bottom + gap;
      style.top = Math.min(top, window.innerHeight - menuHeight - 8);
    } else {
      // Clamp so menu doesn't overflow top
      const bottom = window.innerHeight - rect.top + gap;
      style.bottom = Math.min(bottom, window.innerHeight - 8);
    }

    // Anchor right edge to the anchor's right edge
    const rightOffset = window.innerWidth - rect.right;
    if (rightOffset + 160 > window.innerWidth) {
      style.left = rect.left;
    } else {
      style.right = rightOffset;
    }
    setCoords(style);
  }, [open, usePortal, anchorRef, position]);

  // Close on scroll when using portal (the fixed position goes stale) — but NOT
  // when the user is scrolling WITHIN the menu itself (e.g. a long, scrollable
  // option list), which would otherwise dismiss it on the first wheel tick.
  useEffect(() => {
    if (!usePortal || !open) return;
    const onScroll = (e: Event) => {
      const target = e.target as Node | null;
      if (target && ref.current && ref.current.contains(target)) return;
      onClose();
    };
    window.addEventListener("scroll", onScroll, { capture: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [usePortal, open, onClose]);

  const menuEl = (
    <div
      ref={ref}
      role={isMenu ? "menu" : undefined}
      aria-label={label}
      tabIndex={-1}
      // The popup stays mounted while closed (it fades out). `inert` keeps its
      // controls out of the tab order and the accessibility tree meanwhile;
      // `aria-hidden` says the same to tools that do not model `inert`.
      inert={!open}
      aria-hidden={open ? undefined : true}
      className={cn(
        "w-max min-w-[160px] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl card-glass py-1.5 shadow-xl outline-none transition-all duration-150",
        usePortal ? "fixed z-50" : "absolute right-0 z-40",
        !usePortal && (position === "above" ? "bottom-full mb-1" : "top-full mt-1"),
        open
          ? "opacity-100 translate-y-0"
          : "opacity-0 translate-y-1 pointer-events-none",
      )}
      style={usePortal ? coords : undefined}
    >
      <MenuRoleContext.Provider value={isMenu}>{children}</MenuRoleContext.Provider>
    </div>
  );

  // Event boundary: clicks inside the popup must not reach click handlers on
  // the trigger's ancestors (a clickable card, a row). `contents` keeps the
  // wrapper out of layout.
  const boundary = (
    <div role="presentation" className="contents" onClick={(e) => e.stopPropagation()}>
      {menuEl}
    </div>
  );

  if (usePortal) {
    return createPortal(boundary, document.body);
  }
  return boundary;
}

interface PopoverMenuItemProps {
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  variant?: "default" | "danger";
}

export function PopoverMenuItem({
  icon,
  label,
  onClick,
  variant = "default",
}: PopoverMenuItemProps) {
  const inMenu = useContext(MenuRoleContext);
  return (
    <button
      type="button"
      role={inMenu ? "menuitem" : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg mx-1 px-3.5 py-2.5 text-sm transition-colors",
        variant === "danger"
          ? "text-red-400 hover:bg-red-500/10"
          : "text-body hover:bg-surface-hover hover:text-heading",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

export function PopoverMenuSeparator() {
  const inMenu = useContext(MenuRoleContext);
  return <div role={inMenu ? "separator" : undefined} className="my-1.5 border-t border-border" />;
}
