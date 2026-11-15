import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
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
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const keys = useMemo(() => items.map(itemKey), [items, itemKey]);
  const keysRef = useRef(keys);
  keysRef.current = keys;

  // Rows arriving at the head (a new note at the top of a feed). A reader who
  // is further down keeps their place: the virtualizer is told how many rows
  // were added above, as in the chat lists. A reader who has the top of the
  // list in view gets the usual behaviour instead: the new rows push in.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const prepend = useRef<PrependState | null>(null);
  // Rows were added above in a render that has not been committed yet.
  const shiftPending = useRef(false);
  if (prepend.current === null || prepend.current.keys !== keys) {
    let firstItemIndex = nextFirstItemIndex(prepend.current, keys);
    if (prepend.current !== null && firstItemIndex < prepend.current.firstItemIndex) {
      const wrapper = wrapperRef.current;
      const topInView =
        !wrapper || wrapper.getBoundingClientRect().top >= scrollParent.getBoundingClientRect().top - 1;
      if (topInView) firstItemIndex = prepend.current.firstItemIndex;
      else shiftPending.current = true;
    }
    prepend.current = { keys, firstItemIndex };
  }
  const firstItemIndex = prepend.current.firstItemIndex;
  const firstItemIndexRef = useRef(firstItemIndex);
  firstItemIndexRef.current = firstItemIndex;

  // Read once: where to start, and what each row measured last time.
  const [initial] = useState(() => ({
    location: resolveInitialLocation(keys, initialAnchor, gap),
    estimates: initialHeightEstimates(heightScope, keys, estimatedItemHeight + gap),
  }));

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToKey: (key, offset = 0) => {
        const index = keysRef.current.indexOf(key);
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
  // Rows arrived above the viewport in this render: the virtualizer is about
  // to scroll by their height, which is not the reader going anywhere.
  useLayoutEffect(() => {
    if (!shiftPending.current) return;
    shiftPending.current = false;
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
  const onRangeChangeRef = useRef(onRangeChange);
  onRangeChangeRef.current = onRangeChange;
  const handleRange = useCallback((range: ListRange) => {
    // The virtualizer counts from `firstItemIndex`; keep plain list positions.
    const startIndex = range.startIndex - firstItemIndexRef.current;
    const endIndex = range.endIndex - firstItemIndexRef.current;
    lastRenderedIndex.current = endIndex;
    setEndRendered(endIndex >= itemsRef.current.length - 1);
    onRangeChangeRef.current?.({ startIndex, endIndex });
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
      const index = virtualIndex - firstItemIndexRef.current;
      return (
        // Padding, not margin: the virtualizer measures the row's box, and a
        // margin would fall outside it. A row must never measure zero.
        <div style={{ paddingTop: index > 0 ? gap : 0, minHeight: 1 }}>{renderItem(item, index, intro)}</div>
      );
    },
    [renderItem, gap, intro],
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
