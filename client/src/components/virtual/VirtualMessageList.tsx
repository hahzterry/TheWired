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
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { isNearBottom, jumpBehavior, nextPinned } from "@/lib/virtual/bottomPin";
import { initialHeightEstimates, rememberItemHeight } from "@/lib/virtual/itemHeights";
import { nextFirstItemIndex, tailAppended, type PrependState } from "@/lib/virtual/prependShift";

/** Extra pixels rendered above and below the viewport. */
const OVERSCAN = { top: 800, bottom: 800 };

export interface VirtualMessageListHandle {
  /** Go to the newest row. Animates only when it is close. */
  scrollToBottom: (behavior?: "auto" | "smooth") => void;
  /**
   * Bring a row into view. Animates a short hop, goes straight to a far row.
   * False when no row has that key.
   */
  scrollToKey: (key: string, align?: "center" | "start" | "end") => boolean;
  /** Whether the reader is at (near) the newest row right now. */
  isAtBottom: () => boolean;
  /** The scrolling element. */
  scroller: () => HTMLElement | null;
}

export interface VirtualMessageListProps<T> {
  items: readonly T[];
  itemKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** Identity of the conversation. A new key is a new list, opened afresh. */
  listKey: string;
  /** Within this many px of the end counts as "at the bottom". */
  atBottomThreshold: number;
  /**
   * Open on this row instead of the newest one (the unread divider). Read
   * when the list mounts.
   */
  initialRow?: { key: string; align: "center" | "start"; offset?: number } | null;
  /**
   * A row was appended at the tail. Return true to go to it. `atBottom` is
   * where the reader was before it arrived. Default: follow while at the
   * bottom.
   */
  shouldFollow?: (info: { atBottom: boolean; last: T }) => boolean;
  /** A row was appended at the tail and the list did not follow it. */
  onMissedAppend?: () => void;
  /** The reader reached or left the bottom (by scrolling). */
  onAtBottomChange?: (atBottom: boolean) => void;
  /**
   * Keep the newest row in view while content changes height after render
   * (media loading, a streamed reply growing) and the reader is at the
   * bottom. Default true. Pass false when the caller pins the list itself.
   */
  stickToBottom?: boolean;
  /** Every scroll of the list, after the at-bottom state was updated. */
  onScroll?: (scroller: HTMLElement) => void;
  /** The list's content changed height. */
  onContentResize?: (scroller: HTMLElement) => void;
  /** Namespace for remembered row heights. */
  heightScope: string;
  /** Height guess for rows that were never measured. */
  estimatedItemHeight: number;
  /** Blank space above the first and below the last row, in px. */
  paddingTop?: number;
  paddingBottom?: number;
  /** Classes for the scrolling element. */
  className?: string;
  /** Classes for the element wrapping the rows (e.g. a centered column). */
  contentClassName?: string;
  handleRef?: Ref<VirtualMessageListHandle>;
}

interface ListContext {
  paddingTop: number;
  paddingBottom: number;
  contentClassName?: string;
  setListEl: (el: HTMLDivElement | null) => void;
}

/** The element holding the rows; observed for height changes. */
const List: Components<unknown, ListContext>["List"] = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & { context?: ListContext }
>(function List({ context, className, ...rest }, ref) {
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      context?.setListEl(el);
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [context, ref],
  );
  return (
    <div
      {...rest}
      ref={setRefs}
      className={[className, context?.contentClassName].filter(Boolean).join(" ") || undefined}
    />
  );
});

function Header({ context }: { context?: ListContext }) {
  return context?.paddingTop ? <div style={{ height: context.paddingTop }} /> : null;
}

function Footer({ context }: { context?: ListContext }) {
  return context?.paddingBottom ? <div style={{ height: context.paddingBottom }} /> : null;
}

const COMPONENTS: Components<unknown, ListContext> = { List, Header, Footer };

/**
 * A chat-style list that only mounts the rows around the viewport.
 *
 * It opens on the newest row (or on `initialRow`), follows rows appended at
 * the tail while the reader is at the bottom, keeps the reader's place when
 * older rows arrive at the head, and stays on the newest row while content
 * settles its height.
 */
export function VirtualMessageList<T>(props: VirtualMessageListProps<T>) {
  return <VirtualMessageListInner key={props.listKey} {...props} />;
}

function VirtualMessageListInner<T>({
  items,
  itemKey,
  renderItem,
  atBottomThreshold,
  initialRow,
  shouldFollow,
  onMissedAppend,
  onAtBottomChange,
  stickToBottom = true,
  onScroll,
  onContentResize,
  heightScope,
  estimatedItemHeight,
  paddingTop = 0,
  paddingBottom = 0,
  className,
  contentClassName,
  handleRef,
}: VirtualMessageListProps<T>) {
  const virtuoso = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);

  const keys = useMemo(() => items.map(itemKey), [items, itemKey]);
  const keysRef = useRef(keys);

  // Read once: where to open, and what each row measured last time.
  const [initial] = useState(() => {
    const index = initialRow ? keys.indexOf(initialRow.key) : -1;
    return {
      atRow: index >= 0,
      location:
        index >= 0
          ? { index, align: initialRow!.align, offset: initialRow!.offset ?? 0 }
          : keys.length > 0
            ? { index: "LAST" as const, align: "end" as const }
            : undefined,
      estimates: initialHeightEstimates(heightScope, keys, estimatedItemHeight),
    };
  });

  // Whether the reader is at the bottom. Updated on scroll only, and released
  // only by an upward move: content changing under a reader who is at the
  // bottom (history prepended, media loading) must not count as leaving it.
  const nearBottom = useRef(!initial.atRow);
  const reportedAtBottom = useRef(!initial.atRow);
  const lastScrollTop = useRef(0);

  // Rows arriving at the head: tell the virtualizer how many, so the rows on
  // screen stay where they are. Worked out during render because the new
  // index has to reach the virtualizer together with the new rows.
  const prepend = useRef<PrependState | null>(null);
  // Whether the row that just arrived at the tail should be followed.
  const followNext = useRef(false);
  const missedAppend = useRef(false);
  if (prepend.current === null || prepend.current.keys !== keys) {
    const prevKeys = prepend.current?.keys ?? [];
    const firstItemIndex = nextFirstItemIndex(prepend.current, keys);
    if (prepend.current !== null && tailAppended(prevKeys, keys)) {
      const follow = shouldFollow
        ? shouldFollow({ atBottom: nearBottom.current, last: items[items.length - 1] })
        : nearBottom.current;
      followNext.current = follow;
      missedAppend.current = !follow;
    } else {
      followNext.current = false;
    }
    prepend.current = { keys, firstItemIndex };
  }
  keysRef.current = keys;
  const firstItemIndex = prepend.current.firstItemIndex;
  const firstItemIndexRef = useRef(firstItemIndex);
  firstItemIndexRef.current = firstItemIndex;

  // After the commit: go to a followed row, or report a missed one.
  const onMissedAppendRef = useRef(onMissedAppend);
  onMissedAppendRef.current = onMissedAppend;
  useLayoutEffect(() => {
    if (followNext.current) {
      followNext.current = false;
      nearBottom.current = true;
      virtuoso.current?.scrollToIndex({ index: "LAST", align: "end" });
    }
    if (missedAppend.current) {
      missedAppend.current = false;
      onMissedAppendRef.current?.();
    }
  }, [keys]);

  // The virtualizer asks this when the row count grows; answering "auto" makes
  // it go to the new last row once that row has been rendered and measured.
  const followOutput = useCallback(() => (followNext.current ? ("auto" as const) : false), []);

  const rendered = useRef<{ startIndex: number; endIndex: number } | null>(null);
  const handleRange = useCallback((range: ListRange) => {
    // The virtualizer counts from `firstItemIndex`; keep plain list positions.
    rendered.current = {
      startIndex: range.startIndex - firstItemIndexRef.current,
      endIndex: range.endIndex - firstItemIndexRef.current,
    };
  }, []);

  const onAtBottomChangeRef = useRef(onAtBottomChange);
  onAtBottomChangeRef.current = onAtBottomChange;
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const at = nextPinned(nearBottom.current, {
      nearBottom: isNearBottom(el, atBottomThreshold),
      movedUp: top < lastScrollTop.current - 1,
    });
    lastScrollTop.current = top;
    nearBottom.current = at;
    if (at !== reportedAtBottom.current) {
      reportedAtBottom.current = at;
      onAtBottomChangeRef.current?.(at);
    }
    onScrollRef.current?.(el);
  }, [atBottomThreshold]);

  const attachScroller = useCallback(
    (el: HTMLElement | Window | null) => {
      const prev = scrollerRef.current;
      if (prev) prev.removeEventListener("scroll", handleScroll);
      const node = el instanceof HTMLElement ? el : null;
      scrollerRef.current = node;
      if (node) node.addEventListener("scroll", handleScroll, { passive: true });
      setMounted(!!node && !!listRef.current);
    },
    [handleScroll],
  );
  const setListEl = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
    setMounted(!!el && !!scrollerRef.current);
  }, []);
  useEffect(() => () => scrollerRef.current?.removeEventListener("scroll", handleScroll), [handleScroll]);

  // Media and embeds settle their size after render: stay on the newest row
  // while the reader is there.
  useStickToBottom(scrollerRef, listRef, { active: mounted && stickToBottom, nearBottomRef: nearBottom });

  // Callers that pin the list themselves (the AI stream) hear about every
  // height change of the content.
  const onContentResizeRef = useRef(onContentResize);
  onContentResizeRef.current = onContentResize;
  const wantsResize = !!onContentResize;
  useEffect(() => {
    const content = listRef.current;
    if (!mounted || !wantsResize || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (scrollerRef.current) onContentResizeRef.current?.(scrollerRef.current);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [mounted, wantsResize]);

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToBottom: (behavior) => {
        const last = keysRef.current.length - 1;
        if (last < 0) return;
        const how = behavior === "smooth" ? jumpBehavior(last, rendered.current) : "auto";
        if (how === "auto") nearBottom.current = true;
        virtuoso.current?.scrollToIndex({ index: "LAST", align: "end", behavior: how });
      },
      scrollToKey: (key, align = "center") => {
        const index = keysRef.current.indexOf(key);
        if (index < 0) return false;
        virtuoso.current?.scrollToIndex({ index, align, behavior: jumpBehavior(index, rendered.current) });
        return true;
      },
      isAtBottom: () => nearBottom.current,
      scroller: () => scrollerRef.current,
    }),
    [],
  );

  const rememberHeights = useCallback(
    (rows: ListItem<T>[]) => {
      for (const row of rows) {
        if (row.size > 0 && row.data !== undefined) rememberItemHeight(heightScope, itemKey(row.data), row.size);
      }
    },
    [heightScope, itemKey],
  );

  const computeKey = useCallback((_index: number, item: T) => itemKey(item), [itemKey]);
  const itemContent = useCallback(
    // A row must never measure zero. `index` is the row's plain list position.
    (index: number, item: T) => (
      <div style={{ minHeight: 1 }}>{renderItem(item, index - firstItemIndexRef.current)}</div>
    ),
    [renderItem],
  );

  const context = useMemo<ListContext>(
    () => ({ paddingTop, paddingBottom, contentClassName, setListEl }),
    [paddingTop, paddingBottom, contentClassName, setListEl],
  );

  return (
    <Virtuoso
      ref={virtuoso}
      scrollerRef={attachScroller}
      className={className}
      context={context}
      components={COMPONENTS as Components<T, ListContext>}
      data={items}
      firstItemIndex={firstItemIndex}
      computeItemKey={computeKey}
      itemContent={itemContent}
      defaultItemHeight={estimatedItemHeight}
      heightEstimates={initial.estimates}
      initialTopMostItemIndex={initial.location}
      atBottomThreshold={atBottomThreshold}
      followOutput={followOutput}
      increaseViewportBy={OVERSCAN}
      rangeChanged={handleRange}
      itemsRendered={rememberHeights}
    />
  );
}
