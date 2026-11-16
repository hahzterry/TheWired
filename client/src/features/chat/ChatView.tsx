import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { selectIsEncryptedSpace, selectHasSpaceKey } from "../../store/slices/spaceE2eeSlice";
import { selectFeatureEnabled, FEATURE_E2EE_SPACES } from "../../store/slices/featuresSlice";
import { ChatMessage } from "./ChatMessage";
import { ChatReply } from "./ChatReply";
import { ChatEditBanner } from "./ChatEditBanner";
import { ChatInput } from "./ChatInput";
import { useChat } from "./useChat";
import { VirtualMessageList, type VirtualMessageListHandle } from "../../components/virtual/VirtualMessageList";
import { useUnreadDividerFade } from "../../components/chat/useUnreadDividerFade";
import { useFileUpload } from "../../hooks/useFileUpload";
import { usePlaybackBarSpacing } from "../../hooks/usePlaybackBarSpacing";
import { Spinner } from "../../components/ui/Spinner";
import { UnreadDivider } from "../../components/chat/UnreadDivider";
import { useAppSelector, useAppDispatch } from "../../store/hooks";
import { clearUnreadDivider } from "../../store/slices/notificationSlice";
import { useUserPopover } from "../../features/profile/UserPopoverContext";
import { usePermissions } from "../../features/spaces/usePermissions";
import { parseChannelIdPart } from "../../features/spaces/spaceSelectors";
import { canGateSpaceMedia } from "../../features/spaces/spaceType";
import { mayModDelete } from "../../lib/nostr/mutationAuthority";
import { RichContent } from "../../components/content/RichContent";
import { profileCache } from "../../lib/nostr/profileCache";
import { usePollVotesSub } from "../polls/usePollVotesSub";
import { EVENT_KINDS } from "../../types/nostr";
import { AlertCircle, RefreshCw, Lock, ArrowDown } from "lucide-react";
import { ItemBoundary } from "@/components/ui/ErrorBoundary";

type ChatRow =
  | { kind: "message"; key: string; view: ReturnType<typeof useChat>["messages"][number] }
  | { kind: "pending"; key: string; msg: ReturnType<typeof useChat>["pendingMessages"][number] };

const chatRowKey = (row: ChatRow) => row.key;

export function ChatView() {
  const dispatch = useAppDispatch();
  const isLoggedIn = useAppSelector((s) => !!s.identity.pubkey);
  const myPubkey = useAppSelector((s) => s.identity.pubkey);
  const activeSpaceId = useAppSelector((s) => s.spaces.activeSpaceId);
  const activeChannelId = useAppSelector((s) => s.spaces.activeChannelId);
  const spaceMode = useAppSelector(
    (s) => s.spaces.list.find((sp) => sp.id === s.spaces.activeSpaceId)?.mode,
  );
  const mediaGateable = useAppSelector((s) => {
    const space = s.spaces.list.find((sp) => sp.id === s.spaces.activeSpaceId);
    return space ? canGateSpaceMedia(space) : false;
  });
  const memberPubkeys = useAppSelector(
    (s) => s.spaces.list.find((sp) => sp.id === s.spaces.activeSpaceId)?.memberPubkeys,
  );
  const activeSpace = useAppSelector(
    (s) => s.spaces.list.find((sp) => sp.id === s.spaces.activeSpaceId),
  );
  const { can, permissions } = usePermissions(activeSpaceId);
  const isReadOnly = spaceMode === "read";
  const permissionsLoaded = permissions.length > 0;
  const channelIdPart = parseChannelIdPart(activeChannelId);
  const canSend = isLoggedIn && !isReadOnly && (!permissionsLoaded || can("SEND_MESSAGES", channelIdPart));
  const canAttachFiles = !permissionsLoaded || can("ATTACH_FILES", channelIdPart);
  const canEmbedLinks = !permissionsLoaded || can("EMBED_LINKS", channelIdPart);
  // End-to-end encrypted space (docs/E2EE_SPACES.md): chat needs the feature on
  // and this session to hold the space's key; attachments and polls are off.
  const encrypted = useAppSelector(selectIsEncryptedSpace(activeSpaceId));
  const hasSpaceKey = useAppSelector(selectHasSpaceKey(activeSpaceId));
  const e2eeEnabled = useAppSelector(selectFeatureEnabled(FEATURE_E2EE_SPACES));
  const sealedNotice = !encrypted
    ? null
    : !e2eeEnabled
      ? "This space is end-to-end encrypted. Turn on Encrypted spaces in Settings → Features to read and post here."
      : !hasSpaceKey
        ? "This space is end-to-end encrypted. Waiting for an admin to share the key with you."
        : null;
  // Deleting other members' messages: admins and the creator, plus (platform
  // spaces) any role granted MANAGE_MESSAGES here — the relay checks the same roles.
  const canModDelete = mayModDelete(activeSpace, myPubkey, can("MANAGE_MESSAGES", channelIdPart));
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => {
    if (!actionError) return;
    const t = setTimeout(() => setActionError(null), 6000);
    return () => clearTimeout(t);
  }, [actionError]);
  const { openUserPopover } = useUserPopover();

  // File upload — owned here so dropZoneRef covers the entire chat view.
  // ChannelPanel keeps one ChatView alive across spaces: the context key
  // includes the space, so switching spaces drops pending attachments.
  const upload = useFileUpload({
    context: { kind: "space", spaceId: activeSpaceId ?? "", gateable: mediaGateable },
    onContextChange: "drop",
  });
  const { scrollPaddingPx } = usePlaybackBarSpacing();

  // Unread divider: timestamp of old lastRead for this channel
  const dividerTimestamp = useAppSelector(
    (s) => activeChannelId ? s.notifications.unreadDividerTimestamps[activeChannelId] : undefined,
  );

  // Pre-warm member profiles so @-mention autocomplete has data
  useEffect(() => {
    if (memberPubkeys?.length) {
      profileCache.warmPubkeys(memberPubkeys);
    }
  }, [memberPubkeys]);
  const {
    messages,
    pendingMessages,
    replyTo,
    setReplyTo,
    sendMessage,
    sendPoll,
    relayTargets,
    retryMessage,
    editingMessage,
    setEditingMessage,
    deleteMessageForMe,
    deleteMessageForEveryone,
    modDeleteMessage,
    editMessage,
    canEdit,
  } = useChat();

  // A message still sending renders its own just-uploaded space media.
  const pendingMediaContext = useMemo(
    () => ({ tags: activeSpaceId ? [["h", activeSpaceId]] : [], pubkey: myPubkey ?? undefined }),
    [activeSpaceId, myPubkey],
  );

  // Batch one #e votes sub for all polls visible in this channel
  const pollIds = useMemo(
    () =>
      messages
        .filter((m) => m.event.kind === EVENT_KINDS.POLL)
        .map((m) => m.event.id),
    [messages],
  );
  const voteSubRelays = useMemo(
    () => (relayTargets.length ? relayTargets : undefined),
    [relayTargets],
  );
  usePollVotesSub(pollIds, voteSubRelays);

  // The message list is virtualized: only the rows around the viewport are
  // mounted. Confirmed messages and messages still sending are one list.
  const listRef = useRef<VirtualMessageListHandle>(null);
  const rows = useMemo<ChatRow[]>(
    () => [
      ...messages.map((view): ChatRow => ({ kind: "message", key: view.event.id, view })),
      ...pendingMessages.map((msg): ChatRow => ({ kind: "pending", key: msg.tempId, msg })),
    ],
    [messages, pendingMessages],
  );
  const hasMessages = rows.length > 0;
  // Where the reader is: at the bottom (follow new messages) or up in history
  // (keep their place, offer a pill). Same guard as DMConversation.
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [newWhileAway, setNewWhileAway] = useState(false);
  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    setShowScrollButton(!atBottom);
    if (atBottom) setNewWhileAway(false);
  }, []);
  const scrollToBottom = useCallback(() => {
    listRef.current?.scrollToBottom("smooth");
  }, []);

  // Reply jump navigation state
  const [highlightedEventId, setHighlightedEventId] = useState<string | null>(null);
  const [jumpBackEventId, setJumpBackEventId] = useState<string | null>(null);

  const scrollToMessage = useCallback((targetEventId: string, sourceEventId?: string) => {
    // The target may be far outside the rendered window: the list goes there.
    if (!listRef.current?.scrollToKey(targetEventId)) return;

    // Remember source for jump-back
    if (sourceEventId) {
      setJumpBackEventId(sourceEventId);
    }

    setHighlightedEventId(targetEventId);
    setTimeout(() => setHighlightedEventId(null), 1500);
  }, []);

  const handleJumpBack = useCallback(() => {
    if (!jumpBackEventId) return;
    if (!listRef.current?.scrollToKey(jumpBackEventId)) return;
    setHighlightedEventId(jumpBackEventId);
    setTimeout(() => setHighlightedEventId(null), 1500);
    setJumpBackEventId(null);
  }, [jumpBackEventId]);

  // Find the index of the first unread message (for divider placement)
  const unreadStartIndex = dividerTimestamp !== undefined
    ? messages.findIndex((m) => m.event.created_at > dividerTimestamp)
    : -1;
  const dividerEventId = unreadStartIndex >= 0 ? messages[unreadStartIndex].event.id : null;

  // First paint of a channel: the unread divider when there is one, else the
  // bottom (the list reads `initialRow` when it mounts). After that a new
  // message follows the reader only while they are at the bottom; someone
  // reading history keeps their place and gets the "new messages" pill
  // instead (audit 2026-06-10 #52). An own send always jumps down. History
  // arriving above, edits, deletions and the divider fading move nothing.
  const followAppend = useCallback(
    ({ atBottom, last }: { atBottom: boolean; last: ChatRow }) => atBottom || last.kind === "pending",
    [],
  );
  const handleMissedAppend = useCallback(() => setNewWhileAway(true), []);

  // Reset scroll tracking when channel changes
  useEffect(() => {
    setShowScrollButton(false);
    setNewWhileAway(false);
  }, [activeChannelId]);

  const handleDividerFaded = useCallback(() => {
    if (activeChannelId) {
      dispatch(clearUnreadDivider(activeChannelId));
    }
  }, [dispatch, activeChannelId]);
  // The divider's row unmounts when scrolled away, so the list keeps its clock.
  const dividerRemainingMs = useUnreadDividerFade(
    hasMessages && dividerEventId !== null,
    activeChannelId ?? "",
    handleDividerFaded,
  );

  const renderRow = useCallback(
    (row: ChatRow) => {
      if (row.kind === "pending") {
        const msg = row.msg;
        return (
          <div className="flex items-center gap-2 px-4 py-1.5 opacity-60">
            <div className="min-w-0 flex-1 text-sm text-soft">
              <ItemBoundary id={msg.tempId} label="chat-pending" noun="message">
                <RichContent content={msg.content} event={pendingMediaContext} layout="message" />
              </ItemBoundary>
            </div>
            {msg.status === "pending" && <Spinner size="sm" />}
            {msg.status === "failed" && (
              <div className="flex items-center gap-1">
                <AlertCircle size={14} className="text-red-400" />
                <button
                  onClick={() => retryMessage(msg.tempId)}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  <RefreshCw size={12} />
                </button>
              </div>
            )}
          </div>
        );
      }
      const { event, isEdited, displayContent } = row.view;
      return (
        <div
          data-event-id={event.id}
          className={highlightedEventId === event.id ? "animate-highlight-flash rounded" : ""}
        >
          {event.id === dividerEventId && <UnreadDivider fadeAfterMs={dividerRemainingMs()} />}
          <ItemBoundary id={event.id} label="chat-message" noun="message" className="mx-4 my-1">
            <ChatMessage
              event={event}
              displayContent={displayContent}
              isEdited={isEdited}
              isOwnMessage={event.pubkey === myPubkey}
              canModDelete={canModDelete}
              canEdit={canEdit(event)}
              isMentioned={!!(myPubkey && event.pubkey !== myPubkey && event.tags.some((t) => t[0] === "p" && t[1] === myPubkey))}
              onReply={
                isLoggedIn
                  ? (eventId, pubkey) => setReplyTo({ eventId, pubkey })
                  : undefined
              }
              onMentionClick={openUserPopover}
              onDeleteForMe={deleteMessageForMe}
              onDeleteForEveryone={deleteMessageForEveryone}
              onModDelete={(eventId) => {
                setActionError(null);
                modDeleteMessage(eventId).catch((err: unknown) =>
                  setActionError(err instanceof Error ? err.message : "Couldn't delete that message."),
                );
              }}
              onEdit={(ev) => setEditingMessage({ event: ev, displayContent })}
              onJumpToMessage={(targetId) => scrollToMessage(targetId, event.id)}
            />
          </ItemBoundary>
        </div>
      );
    },
    [
      pendingMediaContext,
      retryMessage,
      highlightedEventId,
      dividerEventId,
      dividerRemainingMs,
      myPubkey,
      canModDelete,
      canEdit,
      isLoggedIn,
      setReplyTo,
      openUserPopover,
      deleteMessageForMe,
      deleteMessageForEveryone,
      modDeleteMessage,
      setEditingMessage,
      scrollToMessage,
    ],
  );

  return (
    <div ref={upload.dropZoneRef} className="relative flex flex-1 flex-col overflow-hidden">
      {/* Drag overlay — covers the entire chat view */}
      {upload.dragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-primary/40 bg-primary/[0.06] backdrop-blur-[1px]">
          <div className="rounded-xl bg-surface/80 px-6 py-4 text-center shadow-lg border border-primary/20">
            <p className="text-sm font-medium text-primary">Drop files to attach</p>
            <p className="mt-1 text-xs text-muted">Images, videos, audio, or PDFs</p>
          </div>
        </div>
      )}

      {/* The composer lifts itself above the floating player, so the list
          only needs the extra bottom room when there is no composer. */}
      {!hasMessages ? (
        <div className="flex-1 overflow-y-auto py-2">
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted">
              No messages yet. Start the conversation!
            </p>
          </div>
        </div>
      ) : (
        <VirtualMessageList
          handleRef={listRef}
          items={rows}
          itemKey={chatRowKey}
          renderItem={renderRow}
          listKey={activeChannelId ?? activeSpaceId ?? "chat"}
          className="flex-1"
          testId="chat-message-list"
          atBottomThreshold={80}
          initialRow={
            dividerEventId !== null && unreadStartIndex > 0
              ? { key: dividerEventId, align: "center" }
              : null
          }
          shouldFollow={followAppend}
          onMissedAppend={handleMissedAppend}
          onAtBottomChange={handleAtBottomChange}
          heightScope="chat"
          estimatedItemHeight={56}
          paddingTop={8}
          paddingBottom={isReadOnly && scrollPaddingPx ? scrollPaddingPx : 8}
        />
      )}

      {/* Back to the newest message; labelled when messages arrived while reading history */}
      {showScrollButton && !jumpBackEventId && (
        <button
          onClick={scrollToBottom}
          className={`absolute right-4 bottom-20 z-10 flex items-center gap-1.5 rounded-full border border-border bg-surface shadow-lg text-xs font-medium transition-all animate-fade-in-up ${
            newWhileAway
              ? "px-3 py-1.5 text-heading hover:bg-surface-hover"
              : "h-9 w-9 justify-center text-muted hover:text-heading hover:bg-surface-hover"
          }`}
          title="Scroll to bottom"
        >
          <ArrowDown size={newWhileAway ? 12 : 16} />
          {newWhileAway && "New messages"}
        </button>
      )}

      {/* Jump back button */}
      {jumpBackEventId && (
        <button
          onClick={handleJumpBack}
          className="absolute right-4 bottom-20 z-10 flex items-center gap-1.5 rounded-full bg-primary/90 px-3 py-1.5 text-xs font-medium text-white shadow-lg hover:bg-primary transition-colors animate-fade-in-up"
        >
          <ArrowDown size={12} />
          Jump back
        </button>
      )}

      {actionError && (
        <div role="alert" className="flex items-center gap-2 border-t border-border px-4 py-2 text-xs text-red-400">
          <AlertCircle size={14} />
          <span className="flex-1">{actionError}</span>
          <button onClick={() => setActionError(null)} className="text-muted hover:text-soft">
            Dismiss
          </button>
        </div>
      )}

      {replyTo && !editingMessage && (
        <ChatReply pubkey={replyTo.pubkey} onCancel={() => setReplyTo(null)} />
      )}

      {editingMessage && (
        <ChatEditBanner
          originalContent={editingMessage.displayContent}
          onCancel={() => setEditingMessage(null)}
        />
      )}

      {isReadOnly ? (
        <div className="flex items-center justify-center gap-2 border-t border-border px-4 py-3 text-muted">
          <Lock size={14} />
          <span className="text-xs">This is a read-only space</span>
        </div>
      ) : (
        <>
        {sealedNotice && (
          <div
            role="status"
            className="flex items-center justify-center gap-2 border-t border-border px-4 py-2 text-muted"
          >
            <Lock size={14} />
            <span className="text-xs">{sealedNotice}</span>
          </div>
        )}
        <ChatInput
          onSend={(content, mentions, attachments, emojiTags) => sendMessage(content, mentions, attachments, emojiTags)}
          onCreatePoll={encrypted ? undefined : sendPoll}
          disabled={!canSend || sealedNotice !== null}
          memberPubkeys={memberPubkeys}
          spaceId={activeSpaceId}
          attachments={upload.attachments}
          onRemoveAttachment={upload.removeAttachment}
          onRetryAttachment={upload.retryAttachment}
          onClearAttachments={upload.clearAttachments}
          onOpenFilePicker={upload.openFilePicker}
          onAddFiles={upload.addFiles}
          fileInputRef={upload.fileInputRef}
          onFileInputChange={upload.handleFileInputChange}
          isUploading={upload.isUploading}
          hasAttachments={upload.hasAttachments}
          editingMessage={editingMessage}
          onEditSubmit={editMessage}
          onEditCancel={() => setEditingMessage(null)}
          canAttachFiles={canAttachFiles && !encrypted}
          canEmbedLinks={canEmbedLinks}
        />
        </>
      )}
    </div>
  );
}
