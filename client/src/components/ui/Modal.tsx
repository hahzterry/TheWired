import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useEscapeLayer, useModalFocus } from "./layer";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Accessible name. Without `label` / `labelledBy` the first heading inside
   *  the dialog (h1–h3 or `[data-dialog-title]`) names it. */
  label?: string;
  /** id of the element that names the dialog. */
  labelledBy?: string;
  /** id of the element that describes the dialog. */
  describedBy?: string;
  /** `alertdialog` for confirmations that interrupt the user. */
  role?: "dialog" | "alertdialog";
}

const TITLE = "h1,h2,h3,[data-dialog-title]";

/**
 * Name the dialog after its first heading when the caller gave no name.
 * Re-checked on DOM changes: multi-step dialogs swap their heading.
 */
function useHeadingLabel(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): string | undefined {
  const fallbackId = `${useId()}-title`;
  const [id, setId] = useState<string>();

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) {
      setId(undefined);
      return;
    }
    const sync = () => {
      const heading = container.querySelector<HTMLElement>(TITLE);
      if (heading && !heading.id) heading.id = fallbackId;
      setId(heading?.id);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [enabled, containerRef, fallbackId]);

  return id;
}

export function Modal({
  open,
  onClose,
  children,
  label,
  labelledBy,
  describedBy,
  role = "dialog",
}: ModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Escape closes the top overlay only; focus moves in on open (respecting any
  // child autoFocus), Tab stays inside, and focus returns to the opener on close.
  const isTop = useEscapeLayer(open, onClose);
  useModalFocus(containerRef, open, isTop);
  const headingId = useHeadingLabel(containerRef, open && !label && !labelledBy);

  if (!open) return null;

  return createPortal(
    // Keeps clicks inside the portal from reaching React ancestors of the
    // component that rendered the modal (e.g. a clickable card).
    <div role="presentation" onClick={(e) => e.stopPropagation()}>
      <div
        ref={containerRef}
        role={role}
        aria-modal="true"
        aria-label={label}
        aria-labelledby={label ? undefined : (labelledBy ?? headingId)}
        aria-describedby={describedBy}
        tabIndex={-1}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md animate-fade-in-up outline-none"
      >
        {/* Backdrop: sits behind the content, so a press on it is a press
            outside the dialog. Keyboard users have Escape. */}
        <div role="presentation" className="absolute inset-0 -z-10" onMouseDown={onClose} />
        {children}
      </div>
    </div>,
    document.body,
  );
}
