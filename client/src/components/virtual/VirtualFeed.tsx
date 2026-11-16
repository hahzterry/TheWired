import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { Virtuoso, type Components, type ListItem, type ListRange, type VirtuosoHandle } from "react-virtuoso";
import { initialHeightEstimates, rememberItemHeight } from "@/lib/virtual/itemHeights";
import { nextFirstItemIndex, type PrependState } from "@/lib/virtual/prependShift";
import { markProgrammaticScroll } from "@/lib/virtual/viewportAnchor";
import { useViewportAnchor } from "./useViewportAnchor";

/** Extra pixels rendered above and below the viewport. */
const OVERSCAN = { top: 600, bottom: 1000 };
/** How long the first rows may play their entrance animation. */
const INTRO_MS = 1500;
/** How long a jump made through the list may take to land. */
const JUMP_MS = 1200;

interface FeedContext {
  setListEl: (el: HTMLDivElement | null) => void;
}

/** The element holding the rows; handed to the viewport anchor. */
const FeedList: Components<unknown, FeedContext>["List"] = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & { context?: FeedContext }
>(function FeedList({ context, ...rest }, ref) {
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      context?.setListEl(el);
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [context, ref],
  );
  return <div {...rest} ref={setRefs} />;
});

const FEED_COMPONENTS: Components<unknown, FeedContext> = { List: FeedList };

export interface VirtualFeedHandle {
  /**
   * Bring the row with this key to the top of the viewport, `offset` px
   * scrolled past the top of its content (the gap above a row is not part of
   * its content). True once requested, false when the list is not mounted
   * yet, null when no row has that key.
   */
  scrollToKey: (key: string, offset?: number) => boolean | null;
}

export interface VirtualFeedRange {
  startIndex: number;
  endIndex: number;
}

export interface VirtualFeedProps<T> {
  items: readonly T[];
  itemKey: (item: T) => string;
  /**
   * Render one row. `intro` is true only for the first moments after the list
   * mounts, so entrance animations play once and not every time a row scrolls
   * back into the window.
   */
  renderItem: (item: T, index: number, intro: boolean) => ReactNode;
  /** The element that scrolls. The list renders nothing until it is known. */
  scrollParent: HTMLElement | null;
  /** Identity of the list. A new key is a new list: fresh window and sizes. */
  listKey: string;
  /** Namespace for remembered row heights. */
  heightScope: string;
  /** Height guess for rows that were never measured. */
  estimatedItemHeight: number;
  /** Vertical space between rows, in px. */
  gap?: number;
  /** Row to start on when the list mounts (a restored scroll position). */
  initialAnchor?: { key: string; offset: number } | null;
  /** The range of rows currently rendered, viewport plus overscan. */
  onRangeChange?: (range: VirtualFeedRange) => void;
  /** More rows can be shown without asking the user (local paging). */
  hasMore?: boolean;
  /** Called while the last row is rendered and `hasMore` is true. */
  onLoadMore?: () => void;
  handleRef?: Ref<VirtualFeedHandle>;
}

/**
 * A long feed that only mounts the rows around the viewport.
 *
 * It scrolls inside `scrollParent`, so anything else in that element (a
 * composer or a profile header above, a "load more" control below) keeps
 * scrolling with it.
 */
export function VirtualFeed<T>(props: VirtualFeedProps<T>) {
  if (!props.scrollParent) return null;
  return <VirtualFeedInner key={props.listKey} {...props} scrollParent={props.scrollParent} />;
}

/**
 * Where a list should open: on the saved row, `offset` px past the top of its
 * content. Nothing (open at the top) when there is no saved row, it is no
 * longer in the list, or it is the very top anyway.
 *
 * A row's box starts with the gap that separates it from the row above, and
 * the saved offset is measured from the content below that gap, so the gap is
 * added here. The scroll-restore hook re-pins to the content element itself;
 * the two must aim at the same pixel or whichever settles last wins.
 */
export function resolveInitialLocation(
  keys: readonly string[],
  anchor: { key: string; offset: number } | null | undefined,
  gap = 0,
): { index: number; align: "start"; offset: number } | undefined {
  if (!anchor) return undefined;
  const index = keys.indexOf(anchor.key);
  if (index < 0) return undefined;
  if (index === 0 && anchor.offset <= 0) return undefined;
  return { index, align: "start", offset: anchor.offset + (index > 0 ? gap : 0) };
}

function VirtualFeedInner<T>({
  items,
  itemKey,
  renderItem,
  scrollParent,
  heightScope,
  estimatedItemHeight,
  gap = 0,
  initialAnchor,
  onRangeChange,
  hasMore,
  onLoadMore,
  handleRef,
}: VirtualFeedProps<T> & { scrollParent: HTMLElement }) {
  const virtuoso = useRef<VirtuosoHandle>(null);
  const keys = useMemo(() => items.map(itemKey), [items, itemKey]);

  // The row keys and index of the last render React committed, and whether
  // the top of the list was in view when last looked at. Both are written
  // only outside rendering (an effect, a scroll listener); a render only
  // reads them. React may render this component without committing that
  // render (Strict Mode renders twice, a transition whose render suspends is
  // thrown away and done again), so a render stores nothing itself and takes
  // no measurements.
  const committed = useRef<PrependState | null>(null);
  const topInView = useRef(true);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Rows arriving at the head (a new note at the top of a feed). A reader who
  // is further down keeps their place: the virtualizer is told how many rows
  // were added above, as in the chat lists. A reader who has the top of the
  // list in view gets the usual behaviour instead: the new rows push in.
  let firstItemIndex: number;
  if (committed.current === null) firstItemIndex = nextFirstItemIndex(null, keys);
  else if (committed.current.keys === keys) firstItemIndex = committed.current.firstItemIndex;
  else {
    firstItemIndex = nextFirstItemIndex(committed.current, keys);
    if (firstItemIndex < committed.current.firstItemIndex && topInView.current) {
      firstItemIndex = committed.current.firstItemIndex;
    }
  }

  // Committed with the render, before any layout effect: the latest props for
  // handlers that outlive a render, and whether this commit added rows above.
  const latest = useRef({ items, keys, firstItemIndex, onRangeChange });
  const shifted = useRef(false);
  useInsertionEffect(() => {
    latest.current = { items, keys, firstItemIndex, onRangeChange };
    const prev = committed.current;
    if (prev !== null && prev.keys === keys) return;
    shifted.current = prev !== null && firstItemIndex < prev.firstItemIndex;
    committed.current = { keys, firstItemIndex };
  });

  // Whether the top of the list is in view: looked at when the list scrolls
  // and after its rows change, never while rendering.
  useLayoutEffect(() => {
    const look = () => {
      const wrapper = wrapperRef.current;
      topInView.current =
        !wrapper || wrapper.getBoundingClientRect().top >= scrollParent.getBoundingClientRect().top - 1;
    };
    look();
    scrollParent.addEventListener("scroll", look, { passive: true });
    return () => scrollParent.removeEventListener("scroll", look);
  }, [scrollParent, keys]);

  // Read once: where to start, and what each row measured last time.
  const [initial] = useState(() => ({
    location: resolveInitialLocation(keys, initialAnchor, gap),
    estimates: initialHeightEstimates(heightScope, keys, estimatedItemHeight + gap),
  }));

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToKey: (key, offset = 0) => {
        const index = latest.current.keys.indexOf(key);
        if (index < 0) return null;
        if (!virtuoso.current) return false;
        markProgrammaticScroll(scrollParent, JUMP_MS);
        virtuoso.current.scrollToIndex({ index, align: "start", offset: offset + (index > 0 ? gap : 0) });
        return true;
      },
    }),
    [gap, scrollParent],
  );

  // While the reader is idle, hold the row they are on when content above it
  // changes height (media arriving late in a card above the viewport).
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const feedContext = useMemo<FeedContext>(
    () => ({
      // Never store a passing null: the virtualizer re-attaches refs while it
      // renders, and a null in between would loop this state.
      setListEl: (el) => {
        if (el) setListEl(el);
      },
    }),
    [],
  );
  const expectShift = useViewportAnchor(scrollParent, listEl);
  // Rows arrived above the viewport in this commit: the virtualizer is about
  // to scroll by their height, which is not the reader going anywhere.
  useLayoutEffect(() => {
    if (!shifted.current) return;
    shifted.current = false;
    expectShift();
  });

  // Entrance animations are for the first paint only.
  const [intro, setIntro] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setIntro(false), INTRO_MS);
    return () => clearTimeout(t);
  }, []);

  // Stand-in for an end-of-list sentinel: while the last row is rendered and
  // more can be shown, ask for it.
  // The last rendered index lives in a ref (read fresh by the effect, so a
  // list that just grew is not mistaken for one still showing its end) and a
  // state flag only re-runs the effect when the end comes into the window.
  const lastRenderedIndex = useRef(-1);
  const [endRendered, setEndRendered] = useState(false);
  const handleRange = useCallback((range: ListRange) => {
    // The virtualizer counts from `firstItemIndex`; keep plain list positions.
    const startIndex = range.startIndex - latest.current.firstItemIndex;
    const endIndex = range.endIndex - latest.current.firstItemIndex;
    lastRenderedIndex.current = endIndex;
    setEndRendered(endIndex >= latest.current.items.length - 1);
    latest.current.onRangeChange?.({ startIndex, endIndex });
  }, []);
  // One request per list length: the request is answered by the list growing
  // (or by `hasMore` turning false), never by asking again.
  const askedAtLength = useRef(-1);
  useEffect(() => {
    if (!hasMore || !onLoadMore) {
      askedAtLength.current = -1;
      return;
    }
    if (askedAtLength.current === items.length) return;
    if (lastRenderedIndex.current >= items.length - 1) {
      askedAtLength.current = items.length;
      onLoadMore();
    }
  }, [endRendered, hasMore, onLoadMore, items.length]);

  const rememberHeights = useCallback(
    (rendered: ListItem<T>[]) => {
      for (const row of rendered) {
        if (row.size > 0 && row.data !== undefined) {
          rememberItemHeight(heightScope, itemKey(row.data), row.size);
        }
      }
    },
    [heightScope, itemKey],
  );

  const computeKey = useCallback((_index: number, item: T) => itemKey(item), [itemKey]);

  const itemContent = useCallback(
    (virtualIndex: number, item: T) => {
      const index = virtualIndex - firstItemIndex;
      return (
        // Padding, not margin: the virtualizer measures the row's box, and a
        // margin would fall outside it. A row must never measure zero.
        <div style={{ paddingTop: index > 0 ? gap : 0, minHeight: 1 }}>{renderItem(item, index, intro)}</div>
      );
    },
    [renderItem, gap, intro, firstItemIndex],
  );

  return (
    <div ref={wrapperRef}>
    <Virtuoso
      ref={virtuoso}
      customScrollParent={scrollParent}
      context={feedContext}
      components={FEED_COMPONENTS as Components<T, FeedContext>}
      data={items}
      firstItemIndex={firstItemIndex}
      computeItemKey={computeKey}
      itemContent={itemContent}
      defaultItemHeight={estimatedItemHeight + gap}
      heightEstimates={initial.estimates}
      initialTopMostItemIndex={initial.location}
      increaseViewportBy={OVERSCAN}
      rangeChanged={handleRange}
      itemsRendered={rememberHeights}
    />
    </div>
  );
}
