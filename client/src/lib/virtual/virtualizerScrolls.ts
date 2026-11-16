/**
 * Tells a list's own scrolling apart from everyone else's.
 *
 * react-virtuoso moves a list only through the scrolling element's `scrollBy`
 * (to correct its offset after rows are measured, to make room for rows added
 * above) and `scrollTo` (to reach a row). The reader, the browser and plain
 * `scrollTop` writes never go that way. Wrapping those two methods on the one
 * element is how its scrolls are seen as they happen.
 *
 * This leans on how the library is built, not on its API. The dependency is
 * pinned to an exact version for that reason, and
 * `components/virtual/__tests__/virtualizerScrollContract.test.tsx` fails if
 * a version scrolls any other way.
 */

export type VirtualizerScrollMethod = "scrollBy" | "scrollTo";

/**
 * Called inside the virtualizer's call, right after the element has moved.
 * `delta` is how far it moved synchronously, in px (an animated scroll moves
 * nothing yet and reports 0).
 */
export type VirtualizerScrollListener = (delta: number, method: VirtualizerScrollMethod) => void;

const listeners = new WeakMap<HTMLElement, Set<VirtualizerScrollListener>>();

/** Hear every scroll the virtualizer makes on `scroller`. Returns the unsubscribe. */
export function onVirtualizerScroll(scroller: HTMLElement, listener: VirtualizerScrollListener): () => void {
  let set = listeners.get(scroller);
  if (!set) {
    const added = new Set<VirtualizerScrollListener>();
    listeners.set(scroller, added);
    set = added;
    const wrap = (method: VirtualizerScrollMethod) => {
      const original = (scroller[method] as (...args: unknown[]) => void).bind(scroller);
      return (...args: unknown[]) => {
        const before = scroller.scrollTop;
        original(...args);
        const delta = scroller.scrollTop - before;
        for (const each of [...added]) each(delta, method);
      };
    };
    scroller.scrollBy = wrap("scrollBy") as typeof scroller.scrollBy;
    scroller.scrollTo = wrap("scrollTo") as typeof scroller.scrollTo;
  }
  set.add(listener);
  const subscribed = set;
  return () => {
    subscribed.delete(listener);
  };
}
