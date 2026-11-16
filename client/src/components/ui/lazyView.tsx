import { Suspense, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { preloadable, type Preloadable } from "@/lib/lazyPreload";
import { ModalBoundary } from "./ModalBoundary";
import { ModalLoading } from "./LazyFallbacks";

/**
 * Lazy boundaries with their Suspense fallback built in, so a call site swaps
 * a static import for one of these and renders it exactly as before.
 *
 * Both are built on `lazyWithRetry`: a failed chunk surfaces in the nearest
 * error boundary with Reload, and that boundary's retry imports again. Both
 * carry a `preload()` for `preloadOnIntent` / `preloadWhenIdle`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

export type LazyComponent<T extends AnyComponent> = ComponentType<ComponentProps<T>> & Preloadable;

/**
 * A lazily loaded view that fills a slot. `fallback` should occupy the same
 * slot (see `PanelLoading`), so nothing shifts when the view arrives. The
 * nearest error boundary above the call site handles a failed load.
 */
export function lazyView<T extends AnyComponent>(
  load: () => Promise<{ default: T }>,
  fallback: ReactNode,
): LazyComponent<T> {
  const loader = preloadable(load);
  const Inner = lazyWithRetry(loader);

  function LazyView(props: ComponentProps<T>) {
    return (
      <Suspense fallback={fallback}>
        <Inner {...props} />
      </Suspense>
    );
  }
  LazyView.displayName = "LazyView";
  LazyView.preload = loader.preload;
  return LazyView;
}

interface ModalLikeProps {
  onClose: () => void;
  open?: boolean;
}

/**
 * A lazily loaded modal. Differences from `lazyView`:
 *
 * - The chunk is not requested until the modal is first open, so a call site
 *   that keeps `<Modal open={false} />` mounted costs nothing.
 * - Once it has been open it stays mounted, as it was before it was lazy, so a
 *   modal that keeps state between openings still does.
 * - It brings its own `ModalBoundary`. A modal's usual boundary comes from
 *   `withModalBoundary` inside the modal's module, which is the very thing
 *   that failed to load, so a chunk failure needs one out here: a dismissible
 *   dialog with Try again and Reload.
 */
export function lazyModal<T extends AnyComponent>(
  load: () => Promise<{ default: T }>,
  label: string,
): LazyComponent<T> {
  const loader = preloadable(load);
  const Inner = lazyWithRetry(loader);

  function LazyModal(props: ComponentProps<T>) {
    const { open, onClose } = props as ModalLikeProps;
    const isOpen = open !== false;
    const [everOpen, setEverOpen] = useState(isOpen);
    if (isOpen && !everOpen) setEverOpen(true);
    if (!everOpen && !isOpen) return null;

    return (
      <ModalBoundary label={label} onClose={onClose} open={open}>
        <Suspense fallback={isOpen ? <ModalLoading onClose={onClose} /> : null}>
          <Inner {...props} />
        </Suspense>
      </ModalBoundary>
    );
  }
  LazyModal.displayName = `LazyModal(${label})`;
  LazyModal.preload = loader.preload;
  return LazyModal;
}
