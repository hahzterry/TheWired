import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useEscapeLayer, useModalFocus } from "./layer";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Accessible name for a dialog with no visible title. A dialog with a
   *  visible title renders it with `<ModalTitle>` instead. */
  label?: string;
  /** id of the element that names the dialog, when it is neither of the above. */
  labelledBy?: string;
  /** id of the element that describes the dialog. */
  describedBy?: string;
  /** `alertdialog` for confirmations that interrupt the user. */
  role?: "dialog" | "alertdialog";
}

interface TitleRegistry {
  register: (id: string) => void;
  unregister: (id: string) => void;
}

/** Lets a `<ModalTitle>` tell the dialog it is in which element names it. */
const ModalTitleContext = createContext<TitleRegistry | null>(null);

type TitleTag = "h1" | "h2" | "h3" | "h4" | "p" | "div" | "span";

interface ModalTitleProps extends HTMLAttributes<HTMLElement> {
  /** Element to render. Defaults to `h2`. */
  as?: TitleTag;
}

/**
 * The visible title of a dialog. Renders a heading (styling is the caller's)
 * and names the surrounding `<Modal>` after it. The dialog learns its name
 * from this declaration, not by searching its content, so a heading that
 * happens to come first (a note, an article, a profile name) is never
 * mistaken for the title.
 */
export function ModalTitle({ as: Tag = "h2", id, children, ...rest }: ModalTitleProps) {
  const registry = useContext(ModalTitleContext);
  const ownId = useId();
  const titleId = id ?? ownId;

  useLayoutEffect(() => {
    if (!registry) return;
    registry.register(titleId);
    return () => registry.unregister(titleId);
  }, [registry, titleId]);

  return (
    <Tag id={titleId} {...rest}>
      {children}
    </Tag>
  );
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

  // Titles mounted inside this dialog, oldest first. A multi-step dialog
  // mounts the next step's title before the previous one unmounts.
  const [titleIds, setTitleIds] = useState<string[]>([]);
  const register = useCallback((id: string) => setTitleIds((ids) => [...ids, id]), []);
  const unregister = useCallback((id: string) => setTitleIds((ids) => ids.filter((other) => other !== id)), []);
  const registry = useMemo(() => ({ register, unregister }), [register, unregister]);
  const titleId = titleIds[titleIds.length - 1];

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
        aria-labelledby={label ? undefined : (labelledBy ?? titleId)}
        aria-describedby={describedBy}
        tabIndex={-1}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md animate-fade-in-up outline-none"
      >
        {/* Backdrop: sits behind the content, so a press on it is a press
            outside the dialog. Keyboard users have Escape. */}
        <div role="presentation" className="absolute inset-0 -z-10" onMouseDown={onClose} />
        <ModalTitleContext.Provider value={registry}>{children}</ModalTitleContext.Provider>
      </div>
    </div>,
    document.body,
  );
}
