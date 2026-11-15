/**
 * Helpers for testing virtualized lists (react-virtuoso) in jsdom, which has
 * no layout: the list is given a viewport and a row height through
 * `VirtuosoMockContext`, and renders the rows that fit.
 */
import type { ReactNode } from "react";
import { waitFor } from "@testing-library/react";
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

/** Pretend a virtual list's scroller is scrolled somewhere and tell the list. */
export function setScrollGeometry(
  scroller: HTMLElement,
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
): void {
  for (const [prop, value] of Object.entries(geometry)) {
    Object.defineProperty(scroller, prop, { value, configurable: true, writable: true });
  }
  scroller.dispatchEvent(new Event("scroll"));
}
