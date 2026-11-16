import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { LAZY_SPINNER_DELAY_MS } from "@/lib/lazyPreload";
import { Modal } from "./Modal";
import { Spinner } from "./Spinner";

function useDelayed(delayMs: number): boolean {
  const [shown, setShown] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) return;
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  return shown;
}

function LoadingMark({ delayMs, label }: { delayMs: number; label: string }) {
  const shown = useDelayed(delayMs);
  if (!shown) return null;
  return (
    <span className="animate-fade-in">
      {/* The spinner is the status region and carries the label as text. */}
      <Spinner label={label} />
    </span>
  );
}

interface PanelLoadingProps {
  /** What is loading, for assistive tech ("Loading settings"). */
  label?: string;
  className?: string;
  delayMs?: number;
}

/**
 * Suspense fallback for a view that fills its slot (a route, a channel view, a
 * sidebar). The box takes the slot's full size at once, so the surrounding
 * layout does not move when the view arrives; only the spinner is delayed.
 */
export function PanelLoading({
  label = "Loading",
  className,
  delayMs = LAZY_SPINNER_DELAY_MS,
}: PanelLoadingProps) {
  return (
    <div
      data-lazy-fallback="panel"
      className={cn("flex min-h-0 flex-1 items-center justify-center", className)}
    >
      <LoadingMark delayMs={delayMs} label={label} />
    </div>
  );
}

interface ModalLoadingProps {
  onClose: () => void;
  delayMs?: number;
}

/**
 * Suspense fallback for a lazily loaded modal. Nothing for the first moment
 * (the usual case: the dialog simply opens), then the dialog backdrop with a
 * spinner, dismissible like the dialog it stands in for.
 */
export function ModalLoading({ onClose, delayMs = LAZY_SPINNER_DELAY_MS }: ModalLoadingProps) {
  const shown = useDelayed(delayMs);
  if (!shown) return null;
  return (
    <Modal open onClose={onClose} label="Loading">
      <span data-lazy-fallback="modal">
        <Spinner size="lg" />
      </span>
    </Modal>
  );
}
