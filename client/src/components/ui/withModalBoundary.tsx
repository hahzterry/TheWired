import type { ComponentType } from "react";
import { ModalBoundary } from "./ModalBoundary";

/**
 * Wrap a modal component in a {@link ModalBoundary} at its definition, so every
 * place that mounts it is covered without touching the call sites.
 */
export function withModalBoundary<P extends { onClose: () => void; open?: boolean }>(
  Inner: ComponentType<P>,
  label: string,
): ComponentType<P> {
  function Bounded(props: P) {
    return (
      <ModalBoundary label={label} onClose={props.onClose} open={props.open}>
        <Inner {...props} />
      </ModalBoundary>
    );
  }
  Bounded.displayName = `ModalBoundary(${label})`;
  return Bounded;
}
