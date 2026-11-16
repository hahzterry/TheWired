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
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { isNearBottom, jumpBehavior, nextPinned, nextStuck } from "@/lib/virtual/bottomPin";
import { initialHeightEstimates, rememberItemHeight } from "@/lib/virtual/itemHeights";
import { nextFirstItemIndex, tailAppended, type PrependState } from "@/lib/virtual/prependShift";
import { markProgrammaticScroll } from "@/lib/virtual/viewportAnchor";
import { useViewportAnchor } from "./useViewportAnchor";

/** Extra pixels rendered above and below the viewport. */
const OVERSCAN = { top: 800, bottom: 800 };
/** How long a jump made through the list may take to land. */
const JUMP_MS = 1200;
/** Within this many px of the end is the very end. */
const END_PX = 2;

/**
 * Add to `delta` every pixel the virtualizer scrolls `scroller` itself. It
 * always goes through the element's `scrollBy` / `scrollTo`; wrapping those
 * two on this one element is how its scrolls are told from everyone else's.
 * (An animated `scrollTo` moves nothing synchronously and so adds nothing;
 * the list's own animated jumps set the pin themselves.)
 *
 * This leans on how react-virtuoso is built, not on its API. The dependency
 * is pinned to an exact version for that reason, and
 * `__tests__/virtualizerScrollContract.test.tsx` fails if a version scrolls
 * any other way. Update the library only together with that test passing.
 */
function noteVirtualizerScrolls(scroller: HTMLElement, delta: { current: number }): void {
  const marked = scroller as HTMLElement & { __virtualizerScrollsNoted?: boolean };
  if (marked.__virtualizerScrollsNoted) return;
  marked.__virtualizerScrollsNoted = true;
  const wrap = (original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const before = scroller.scrollTop;
      original(...args);
      delta.current += scroller.scrollTop - before;
    };
  scroller.scrollBy = wrap(scroller.scrollBy.bind(scroller) as (...args: unknown[]) => void) as typeof scroller.scrollBy;
  scroller.scrollTo = wrap(scroller.scrollTo.bind(scroller) as (...args: unknown[]) => void) as typeof scroller.scrollTo;
}

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
  /**
   * Every scroll of the list, after the at-bottom state was updated.
   * `byVirtualizer` is how many px of it the virtualizer moved the list
   * itself (negative: up), to correct its offset or to make room for rows
   * added above. The rest is the reader's, or the caller's own scrolling.
   */
  onScroll?: (scroller: HTMLElement, byVirtualizer: number) => void;
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
  /** `data-testid` for the scrolling element. */
  testId?: string;
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
  testId,
  handleRef,
}: VirtualMessageListProps<T>) {
  const virtuoso = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  // The same two elements as state, for the hooks that attach to them.
  const [elements, setElements] = useState<{ scroller: HTMLElement | null; list: HTMLDivElement | null }>({
    scroller: null,
    list: null,
  });

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
  // only by a scroll that moves up and is not the virtualizer's own: content
  // changing under a reader who is at the bottom (history prepended, media
  // loading, the window growing) must not count as leaving it.
  const nearBottom = useRef(!initial.atRow);
  const reportedAtBottom = useRef(!initial.atRow);
  const lastScrollTop = useRef(0);
  // Whether the list holds itself on its newest row when sizes change. Let go
  // by any upward move of the reader, even inside the threshold (see
  // `nextStuck`); `nearBottom` above is the looser "at the bottom" that
  // decides whether a new message is followed.
  const stuck = useRef(!initial.atRow);
  // How far the virtualizer has scrolled the list itself since the last scroll
  // event. It does that through the scroller's `scrollBy` / `scrollTo` (to
  // correct its offset after rows are measured again, to make room for
  // prepended rows, to reach a row); the reader, the browser and plain
  // `scrollTop` writes never go that way. Subtracting it from a scroll
  // event's total leaves what the reader did, even when both moved the list
  // within the same frame.
  const virtualizerDelta = useRef(0);

  // The row keys and index of the last render React committed. Written only
  // in the commit phase (below); a render only reads it. React may render
  // this component and never commit that render (Strict Mode renders twice,
  // a transition whose render suspends is thrown away and done again), so
  // nothing a render works out may be stored by the render itself.
  const committed = useRef<PrependState | null>(null);

  // Rows arriving at the head: tell the virtualizer how many, so the rows on
  // screen stay where they are. Worked out during render because the new
  // index has to reach the virtualizer together with the new rows, and from
  // the committed state alone, so every render of the same rows agrees.
  const firstItemIndex =
    committed.current === null
      ? nextFirstItemIndex(null, keys)
      : committed.current.keys === keys
        ? committed.current.firstItemIndex
        : nextFirstItemIndex(committed.current, keys);
  const firstItemIndexRef = useRef(firstItemIndex);

  // What this commit changed, decided once per commit. It is decided before
  // any layout effect runs (an insertion effect does): the virtualizer reads
  // `followOutput` from its own layout effect, which runs before this
  // component's.
  const change = useRef({ shifted: false, follow: false, missed: false });
  // The caller's latest callbacks and options, for handlers that outlive a
  // render. Also committed here, not written while rendering.
  const latest = useRef({ onMissedAppend, onAtBottomChange, onScroll, onContentResize, stickToBottom });
  useInsertionEffect(() => {
    latest.current = { onMissedAppend, onAtBottomChange, onScroll, onContentResize, stickToBottom };
    firstItemIndexRef.current = firstItemIndex;
    keysRef.current = keys;
    const prev = committed.current;
    if (prev !== null && prev.keys === keys) return;
    const appended = prev !== null && tailAppended(prev.keys, keys);
    const follow =
      appended &&
      (shouldFollow ? shouldFollow({ atBottom: nearBottom.current, last: items[items.length - 1] }) : nearBottom.current);
    change.current = {
      shifted: prev !== null && firstItemIndex < prev.firstItemIndex,
      follow,
      missed: appended && !follow,
    };
    committed.current = { keys, firstItemIndex };
  });

  // The virtualizer asks this when the row count grows; answering "auto" makes
  // it go to the new last row once that row has been rendered and measured.
  const followOutput = useCallback(() => (change.current.follow ? ("auto" as const) : false), []);

  // After the commit: go to a followed row, or report a missed one.
  useLayoutEffect(() => {
    const { follow, missed } = change.current;
    change.current.follow = false;
    change.current.missed = false;
    if (follow) {
      nearBottom.current = true;
      stuck.current = true;
      markProgrammaticScroll(scrollerRef.current, JUMP_MS);
      virtuoso.current?.scrollToIndex({ index: "LAST", align: "end" });
    }
    if (missed) latest.current.onMissedAppend?.();
  });

  const rendered = useRef<{ startIndex: number; endIndex: number } | null>(null);
  const handleRange = useCallback((range: ListRange) => {
    // The virtualizer counts from `firstItemIndex`; keep plain list positions.
    rendered.current = {
      startIndex: range.startIndex - firstItemIndexRef.current,
      endIndex: range.endIndex - firstItemIndexRef.current,
    };
  }, []);

  const setAtBottom = useCallback((at: boolean) => {
    nearBottom.current = at;
    if (at !== reportedAtBottom.current) {
      reportedAtBottom.current = at;
      latest.current.onAtBottomChange?.(at);
    }
  }, []);
  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const byVirtualizer = virtualizerDelta.current;
    virtualizerDelta.current = 0;
    const byReader = top - lastScrollTop.current - byVirtualizer;
    const near = isNearBottom(el, atBottomThreshold);
    const at = nextPinned(nearBottom.current, { nearBottom: near, movedUp: byReader < -1 });
    stuck.current = nextStuck(stuck.current, {
      readerMoved: byReader,
      nearBottom: near,
      atVeryEnd: isNearBottom(el, END_PX),
    });
    lastScrollTop.current = top;
    setAtBottom(at);
    // Holding the end, yet the virtualizer has just moved the list away from
    // it: it corrects its offset when rows above are measured again (after
    // the window is resized, say) and does not know the list is pinned.
    if (stuck.current && !near && byVirtualizer < -1 && latest.current.stickToBottom) {
      el.scrollTop = el.scrollHeight;
      lastScrollTop.current = el.scrollTop;
    }
    latest.current.onScroll?.(el, byVirtualizer);
  }, [atBottomThreshold, setAtBottom]);

  const attachScroller = useCallback(
    (el: HTMLElement | Window | null) => {
      const prev = scrollerRef.current;
      if (prev) prev.removeEventListener("scroll", handleScroll);
      const node = el instanceof HTMLElement ? el : null;
      scrollerRef.current = node;
      if (node) {
        node.addEventListener("scroll", handleScroll, { passive: true });
        noteVirtualizerScrolls(node, virtualizerDelta);
        // The list scrolls itself to its opening row.
        markProgrammaticScroll(node, JUMP_MS);
      }
      setMounted(!!node && !!listRef.current);
      // Never store a passing null: the virtualizer re-attaches refs while it
      // renders, and a null in between would loop this state.
      if (node) setElements((prev) => (prev.scroller === node ? prev : { ...prev, scroller: node }));
    },
    [handleScroll],
  );
  const setListEl = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
    setMounted(!!el && !!scrollerRef.current);
    if (el) setElements((prev) => (prev.list === el ? prev : { ...prev, list: el }));
  }, []);
  useEffect(() => () => scrollerRef.current?.removeEventListener("scroll", handleScroll), [handleScroll]);

  // Media and embeds settle their size after render: stay on the newest row
  // while the reader is there.
  useStickToBottom(scrollerRef, listRef, { active: mounted && stickToBottom, nearBottomRef: stuck });

  // While the reader is idle up in history, hold the row they are on when
  // content above it changes height.
  const isPinned = useCallback(() => stuck.current, []);
  const expectShift = useViewportAnchor(elements.scroller, elements.list, isPinned);
  // Rows arrived above the viewport in this commit: the virtualizer is about
  // to scroll by their height, which is not the reader going anywhere.
  useLayoutEffect(() => {
    if (!change.current.shifted) return;
    change.current.shifted = false;
    expectShift();
  });

  // The scroller itself changing size (the window, the composer growing a
  // reply banner) moves the end of the list without the content changing:
  // stay on the newest row then too. And callers that pin the list themselves
  // (the AI stream) hear about every height change of the content.
  useEffect(() => {
    const content = listRef.current;
    const scroller = scrollerRef.current;
    if (!mounted || !content || !scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === content) latest.current.onContentResize?.(scroller);
        else if (latest.current.stickToBottom && stuck.current) scroller.scrollTop = scroller.scrollHeight;
      }
    });
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [mounted]);

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToBottom: (behavior) => {
        const last = keysRef.current.length - 1;
        if (last < 0) return;
        const how = behavior === "smooth" ? jumpBehavior(last, rendered.current) : "auto";
        if (how === "auto") {
          nearBottom.current = true;
          stuck.current = true;
        }
        markProgrammaticScroll(scrollerRef.current, JUMP_MS);
        virtuoso.current?.scrollToIndex({ index: "LAST", align: "end", behavior: how });
      },
      scrollToKey: (key, align = "center") => {
        const index = keysRef.current.indexOf(key);
        if (index < 0) return false;
        // A jump away from the newest row is the reader leaving the bottom.
        // (If it lands within the threshold, the scroll there re-attaches.)
        if (index < keysRef.current.length - 1) {
          setAtBottom(false);
          stuck.current = false;
        }
        markProgrammaticScroll(scrollerRef.current, JUMP_MS);
        virtuoso.current?.scrollToIndex({ index, align, behavior: jumpBehavior(index, rendered.current) });
        return true;
      },
      isAtBottom: () => nearBottom.current,
      scroller: () => scrollerRef.current,
    }),
    [setAtBottom],
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
    // A row must never measure zero. The virtualizer counts from
    // `firstItemIndex`; the row gets its plain list position.
    (index: number, item: T) => <div style={{ minHeight: 1 }}>{renderItem(item, index - firstItemIndex)}</div>,
    [renderItem, firstItemIndex],
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
      data-testid={testId}
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
