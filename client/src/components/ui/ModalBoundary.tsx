import { useState, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "./Button";
import { CopyDiagnosticsButton, ErrorBoundary, type BoundaryFallbackProps } from "./ErrorBoundary";
import { Modal } from "./Modal";

interface ModalBoundaryProps {
  children: ReactNode;
  /** Code-side name recorded with the crash (`create-space`). A constant, never data. */
  label: string;
  /** The modal's own close handler. The fallback's Close button calls it. */
  onClose: () => void;
  /**
   * The modal's `open` flag, when it has one. A closed modal that fails shows
   * nothing, and reopening it gets a fresh attempt.
   */
  open?: boolean;
  /**
   * Set when the boundary sits inside an open dialog already (wrapping a
   * `<Modal>`'s children). The fallback then renders just the card, without
   * opening a second backdrop.
   */
  contained?: boolean;
}

/**
 * Error boundary for a modal. It wraps the component that owns the dialog, not
 * the dialog's children, so a throw in the owner's own render is caught too.
 * The fallback is itself a dialog with a Close button wired to the modal's
 * close handler, so a broken modal can always be dismissed.
 */
export function ModalBoundary({ children, label, onClose, open, contained }: ModalBoundaryProps) {
  return (
    <ErrorBoundary
      variant="panel"
      scope="modal"
      label={label}
      resetKeys={[open]}
      fallback={(props) =>
        open === false ? null : (
          <ModalFallback {...props} onClose={onClose} contained={contained} />
        )
      }
    >
      {children}
    </ErrorBoundary>
  );
}

interface ModalFallbackProps extends BoundaryFallbackProps {
  onClose: () => void;
  contained?: boolean;
}

function ModalFallback({ retry, summary, reloadSuggested, onClose, contained }: ModalFallbackProps) {
  // Closing must work even when the owner keeps the broken modal mounted and
  // has no `open` flag to flip: the fallback hides itself as well as asking
  // the owner to close.
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const close = () => {
    setDismissed(true);
    onClose();
  };

  const card = (
    <div
      role="alert"
      data-boundary-fallback="modal"
      className="w-full max-w-sm rounded-2xl border border-border card-glass p-6 text-center shadow-xl"
    >
      <AlertTriangle size={20} className="mx-auto text-warning" />
      <p className="mt-3 text-sm font-medium text-heading">This dialog hit a problem</p>
      <p className="mt-1 text-xs text-muted">
        Close it and carry on, or try opening it again.
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button type="button" size="sm" onClick={close}>
          Close
        </Button>
        <Button type="button" variant="accent" size="sm" onClick={retry} className="gap-1.5">
          <RotateCcw size={14} />
          Try again
        </Button>
        {reloadSuggested && (
          <Button type="button" variant="secondary" size="sm" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        )}
        <CopyDiagnosticsButton />
      </div>
      {import.meta.env.DEV && summary && (
        <code className="mt-3 block break-words rounded-md bg-field px-2 py-1 font-mono text-[11px] text-faint">
          {summary}
        </code>
      )}
    </div>
  );

  if (contained) {
    return <div className="flex min-h-0 flex-1 items-center justify-center p-4">{card}</div>;
  }

  return (
    <Modal open onClose={close}>
      {card}
    </Modal>
  );
}
