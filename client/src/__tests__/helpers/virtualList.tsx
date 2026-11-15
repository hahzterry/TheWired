/**
 * Helpers for testing virtualized lists (react-virtuoso) in jsdom, which has
 * no layout: the list is given a viewport and a row height through
 * `VirtuosoMockContext`, and renders the rows that fit.
 */
import type { ReactNode } from "react";
import { act, waitFor } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";

/** Give every virtual list below a fixed viewport and row height. */
export function VirtualViewport({
  height = 800,
  rowHeight = 100,
  children,
}: {
  height?: number;
  rowHeight?: number;
  children: ReactNode;
}) {
  return (
    <VirtuosoMockContext.Provider value={{ viewportHeight: height, itemHeight: rowHeight }}>
      {children}
    </VirtuosoMockContext.Provider>
  );
}

/**
 * A list that opens on a given row (a chat opens on its newest message) keeps
 * its rows mounted but hidden until its opening scroll has landed. Wait for
 * that before querying by role, which ignores hidden elements.
 */
export async function virtualListSettled(root: ParentNode = document): Promise<HTMLElement> {
  let list: HTMLElement | null = null;
  await waitFor(() => {
    list = root.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]');
    if (!list) throw new Error("no virtual list mounted");
    if (list.style.visibility === "hidden") throw new Error("virtual list still hidden");
    if (list.children.length === 0) throw new Error("virtual list has no rows yet");
  });
  return list!;
}

/**
 * Pretend a virtual list's scroller was scrolled somewhere by the list or the
 * app (no input from the reader) and tell the list.
 */
export function setScrollGeometry(
  scroller: HTMLElement,
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
): void {
  for (const [prop, value] of Object.entries(geometry)) {
    Object.defineProperty(scroller, prop, { value, configurable: true, writable: true });
  }
  scroller.dispatchEvent(new Event("scroll"));
}

/** The reader scrolls the list there: wheel input, then the scroll. */
export function userScrollTo(
  scroller: HTMLElement,
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
): void {
  scroller.dispatchEvent(new Event("wheel"));
  setScrollGeometry(scroller, geometry);
}

/**
 * The virtualizer scrolls the list there itself, the way it does to correct
 * its offset or to make room for rows added above: through the element's
 * `scrollTo`, never by writing `scrollTop`. Resolves once the scroll event
 * has been delivered.
 */
export async function virtualizerScrollTo(
  scroller: HTMLElement,
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
): Promise<void> {
  for (const prop of ["scrollHeight", "clientHeight"] as const) {
    Object.defineProperty(scroller, prop, { value: geometry[prop], configurable: true, writable: true });
  }
  Object.defineProperty(scroller, "scrollTop", { value: scroller.scrollTop, configurable: true, writable: true });
  await act(async () => {
    scroller.scrollTo({ top: geometry.scrollTop });
    await Promise.resolve();
  });
}

/**
 * Replace `ResizeObserver` with one whose notifications a test delivers by
 * hand. jsdom never resizes anything, so this is how a test says "the list's
 * content just changed height". Returns `fire(target)`, which notifies every
 * observer watching that element, and `restore()`.
 */
export function captureResizeObservers(): { fire: (target: Element) => void; restore: () => void } {
  const original = globalThis.ResizeObserver;
  const observers: { callback: ResizeObserverCallback; targets: Set<Element>; self: ResizeObserver }[] = [];
  class ManualResizeObserver {
    private readonly record: (typeof observers)[number];
    constructor(callback: ResizeObserverCallback) {
      this.record = { callback, targets: new Set(), self: this as unknown as ResizeObserver };
      observers.push(this.record);
    }
    observe(target: Element) {
      this.record.targets.add(target);
    }
    unobserve(target: Element) {
      this.record.targets.delete(target);
    }
    disconnect() {
      this.record.targets.clear();
    }
  }
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = ManualResizeObserver;
  return {
    fire(target) {
      for (const { callback, targets, self } of [...observers]) {
        if (!targets.has(target)) continue;
        try {
          callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], self);
        } catch {
          // The virtualizer's own observers measure real layout, which jsdom
          // does not have. Only the app's observers matter to these tests.
        }
      }
    },
    restore() {
      (globalThis as { ResizeObserver: unknown }).ResizeObserver = original;
    },
  };
}

/** The element whose children are a virtual list's rows. */
export function virtualListContent(root: ParentNode = document): HTMLElement {
  return root.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')!;
}
