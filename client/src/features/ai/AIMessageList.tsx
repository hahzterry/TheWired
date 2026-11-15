import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { useAppSelector } from "@/store/hooks";
import {
  selectMessageIdsForConversation,
  selectIsStreaming,
  selectPendingWriteIdsForConversation,
} from "@/store/slices/aiSlice";
import { AIMessageBubble } from "./AIMessageBubble";
import { PendingWriteCard } from "./gate/PendingWriteCard";
import { isAtBottom, nextStick, BOTTOM_PX } from "./scrollFollow";
import { ItemBoundary } from "@/components/ui/ErrorBoundary";
import { VirtualMessageList, type VirtualMessageListHandle } from "@/components/virtual/VirtualMessageList";

/** One row: a chat message, or a write waiting for approval (after the messages). */
type AIRow =
  | { kind: "message"; key: string; id: string; isLast: boolean }
  | { kind: "write"; key: string; id: string };

const aiRowKey = (row: AIRow) => row.key;
/** The list never follows by row count: it follows the content's height below. */
const neverFollow = () => false;

export function AIMessageList({ conversationId }: { conversationId: string }) {
  const messageIds = useAppSelector(selectMessageIdsForConversation(conversationId));
  const isStreaming = useAppSelector(selectIsStreaming(conversationId));
  const pendingWriteIds = useAppSelector(
    selectPendingWriteIdsForConversation(conversationId),
  );

  // The list is virtualized: only the rows around the viewport are mounted.
  const listRef = useRef<VirtualMessageListHandle>(null);
  const rows = useMemo<AIRow[]>(
    () => [
      ...messageIds.map(
        (id, i): AIRow => ({ kind: "message", key: `m:${id}`, id, isLast: i === messageIds.length - 1 }),
      ),
      ...pendingWriteIds.map((id): AIRow => ({ kind: "write", key: `w:${id}`, id })),
    ],
    [messageIds, pendingWriteIds],
  );

  // Whether we're auto-following the bottom. Released when the user scrolls up,
  // re-attached when they return to the bottom (or hit the jump button).
  const stick = useRef(true);
  // True while WE are scrolling, so the resulting scroll event doesn't get
  // mistaken for the user taking over (no feedback loop).
  const programmatic = useRef(false);
  const lastTop = useRef(0);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current?.scroller();
    if (!el) return;
    programmatic.current = true;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
    // The scroll event from the assignment is queued; clear the guard after it
    // (and before paint) so a genuine user scroll on the next frame is honored.
    requestAnimationFrame(() => {
      programmatic.current = false;
    });
  }, []);

  const onScroll = useCallback((el: HTMLElement) => {
    const top = el.scrollTop;
    if (programmatic.current) {
      lastTop.current = top;
      return; // ignore our own scrolling (no feedback loop)
    }
    const m = {
      top,
      lastTop: lastTop.current,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
    stick.current = nextStick(stick.current, m);
    lastTop.current = top;
    setShowJump(!isAtBottom(m));
  }, []);

  // Follow content growth while stuck. The list reports every height change of
  // its content — streamed text, images loading, code blocks, expanded
  // reasoning, pending-write cards, rows being measured — not just
  // message-count/length, so it never lags.
  const onContentResize = useCallback(() => {
    if (stick.current) scrollToBottom();
  }, [scrollToBottom]);

  // Switching conversations: re-attach to the bottom and jump there. (The list
  // itself is rebuilt per conversation and opens on its newest row.)
  useEffect(() => {
    stick.current = true;
    setShowJump(false);
    requestAnimationFrame(scrollToBottom);
  }, [conversationId, scrollToBottom]);

  const jumpToBottom = () => {
    stick.current = true;
    scrollToBottom();
    setShowJump(false);
  };

  const renderRow = useCallback(
    (row: AIRow) =>
      row.kind === "message" ? (
        <ItemBoundary id={row.id} label="ai-message" noun="message" className="mx-4 my-2">
          <AIMessageBubble messageId={row.id} conversationId={conversationId} isLast={row.isLast} />
        </ItemBoundary>
      ) : (
        <ItemBoundary id={row.id} label="ai-pending-write" noun="request" className="mx-4 my-2">
          <PendingWriteCard id={row.id} />
        </ItemBoundary>
      ),
    [conversationId],
  );

  return (
    <div className="relative flex-1 overflow-hidden">
      <VirtualMessageList
        handleRef={listRef}
        items={rows}
        itemKey={aiRowKey}
        renderItem={renderRow}
        listKey={conversationId}
        className="h-full"
        contentClassName="mx-auto max-w-3xl"
        atBottomThreshold={BOTTOM_PX}
        shouldFollow={neverFollow}
        stickToBottom={false}
        onScroll={onScroll}
        onContentResize={onContentResize}
        heightScope="ai"
        estimatedItemHeight={120}
        paddingTop={16}
        paddingBottom={16}
      />

      {showJump && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full bg-surface text-heading shadow-lg ring-1 ring-border transition-colors hover:bg-surface-hover"
          title="Scroll to bottom"
          aria-label="Scroll to latest"
        >
          <ArrowDown size={16} />
        </button>
      )}

      {/* Screen-reader status: announce start/finish, never per token. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {isStreaming ? "Generating response…" : messageIds.length > 0 ? "Response complete" : ""}
      </div>
    </div>
  );
}
