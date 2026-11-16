import type { NostrEvent } from "../../../types/nostr";
import { addDMMessage, editDMMessage, remoteDeleteDMMessage, reactDMMessage, removeDMReaction, setTyping, applyReceipt, markDMWrapProcessed } from "../../../store/slices/dmSlice";
import { parseDMWire } from "@ishtarservices/core";
import { DM_EXPIRATION_SECONDS } from "@ishtarservices/shared-types";
import { queueDeliveredReceipt } from "../dmSignals";
import { unwrapGiftWrap, type UnwrappedDM } from "../giftWrap";
import { GiftWrapRejectedError } from "@ishtarservices/core";
import { GIFT_WRAP_ACCEPT_KINDS, KIND_DM_PROJECT_KEY, parseProjectKeyDM } from "../../../features/music/sharedKey/projectKeyDM";
import { receiveProjectKey } from "../../../features/music/sharedKey/projectKeys";
import { isSecretPersistEnabled } from "../secretStore";
import { evaluateDMNotification } from "../notificationEvaluator";
import { deliverMediaKey } from "../../webrtc/e2ee/mediaKeyInbox";
import type { PipelineContext } from "./types";
import type { createFriendWrapHandlers } from "./friendWraps";
import type { createCallWrapHandlers } from "./callWraps";

/** The per-feature rumor handlers the gift-wrap router hands off to. */
export type WrapHandlers = ReturnType<typeof createFriendWrapHandlers> & ReturnType<typeof createCallWrapHandlers>;

/**
 * Gift wraps (kind 1059): decrypt, validate, and route the rumor to DMs,
 * friend requests, call signalling, media keys or shared-project keys. The
 * decrypt queue calls `handleGiftWrap`; a wrap never takes the `indexEvent`
 * path.
 *
 * The body is the code as it stood inside `createEventPipeline`, at its
 * original indentation.
 */
export function createGiftWrapHandler(ctx: PipelineContext, handlers: WrapHandlers) {
  const { dispatch, getState, dedup } = ctx;
    const {
      handleFriendRequestWrap,
      handleFriendAcceptWrap,
      handleFriendRemoveWrap,
      handleCallInviteWrap,
      handleCallDeclineWrap,
      handleCallMissedWrap,
    } = handlers;

  /** Validate that a string is a 64-character hex pubkey */
  const HEX64_RE = /^[0-9a-f]{64}$/i;

  /** Clock-skew allowance when judging a wrap's expiry (DM_WIRE_CONTRACT §5).
   *  Signal wraps live 45 s; without it a device whose clock runs ~45 s fast
   *  would reject every media key. The relay already refuses to serve an
   *  expired wrap by its own clock, so this only widens the local check. */
  const WRAP_EXPIRY_SKEW_SEC = 60;

  /** Handle incoming gift wrap (kind:1059) — decrypt and route to DM or friend request.
   *  `receivedAt` (unix seconds) is when the wrap reached the decrypt queue:
   *  expiry is judged against it, so a wrap that waited behind a slow signer
   *  (a NIP-46 bunker decrypts one at a time) is not rejected for the wait. */
  async function handleGiftWrap(event: NostrEvent, receivedAt: number = Math.floor(Date.now() / 1000)): Promise<void> {
    const myPubkey = getState().identity.pubkey;
    if (!myPubkey) {
      // Not logged in (yet): nothing about the wrap was judged — let a later copy in.
      dedup.unmarkSeen(event.id);
      return;
    }

    // Only process wraps addressed to us. Recipient wraps from our own sends
    // bounce back from relays but can't be decrypted — some NIP-07 extensions
    // return garbage instead of throwing, creating ghost DM conversations.
    const recipientTag = event.tags.find((t) => t[0] === "p")?.[1];
    if (recipientTag && recipientTag !== myPubkey) return;

    // The wrap was marked in the dedup LRU before it reached this queue. A
    // decrypt that fails because the signer was away (NIP-46 timeout, locked
    // extension, keystore not ready) says nothing about the wrap, so unmark it:
    // the NIP-77 reconcile re-requests ids the slice never processed, and a copy
    // from another relay can arrive any time — either gets a fresh decrypt. A
    // verdict core reached itself (bad seal signature, wrong kind, expired, bad
    // ciphertext) is final for that wrap: it stays marked AND goes into the
    // slice's processed set, so the NIP-77 reconcile (which filters on that
    // set) stops re-requesting it every round.
    let dm: UnwrappedDM;
    try {
      dm = await unwrapGiftWrap(event, {
        acceptKinds: GIFT_WRAP_ACCEPT_KINDS,
        now: receivedAt - WRAP_EXPIRY_SKEW_SEC,
      });
    } catch (err) {
      if (err instanceof GiftWrapRejectedError || (err as { name?: string })?.name === "GiftWrapRejectedError") {
        dispatch(markDMWrapProcessed(event.id));
      } else {
        dedup.unmarkSeen(event.id);
      }
      return;
    }

    try {

      // Validate unwrapped data — guard against corrupted decryptions from
      // wraps not addressed to us (some NIP-07 extensions don't throw on
      // wrong-key decryption, returning garbage that may survive JSON.parse)
      if (!dm.sender || !HEX64_RE.test(dm.sender) || !Array.isArray(dm.tags)) {
        return;
      }

      // Blocked senders (kind-10000 mute list) are dropped before anything renders.
      if (dm.sender !== myPubkey) {
        const muteList = getState().identity.muteList;
        if (muteList.some((m) => m.type === "pubkey" && m.value === dm.sender)) return;
      }

      // Shared-project key DM: intercepted before parseDMWire (which would drop
      // kind 20017 as unsupported) so the nsec never reaches dmSlice or the DM store.
      if (dm.kind === KIND_DM_PROJECT_KEY) {
        handleProjectKeyWrap(dm, myPubkey);
        return;
      }

      // One parser for the spec form (kind 15 / kind 7 / `e` replies / typing /
      // receipts) and the legacy typed-rumor form (docs/DM_WIRE_CONTRACT.md §2).
      const w = parseDMWire(dm, myPubkey);
      const nowSec = Math.round(Date.now() / 1000);
      switch (w.type) {
        case "unknown":
          // Unknown kind / type from a newer client — drop rather than render
          // it as a chat bubble.
          return;
        case "friend_request":
          handleFriendRequestWrap(dm, myPubkey);
          return;
        case "friend_request_accept":
          handleFriendAcceptWrap(dm, myPubkey);
          return;
        case "friend_request_remove":
          handleFriendRemoveWrap(dm, myPubkey);
          return;
        case "call_invite":
          handleCallInviteWrap(dm, myPubkey);
          return;
        case "call_decline":
          handleCallDeclineWrap(dm, myPubkey);
          return;
        case "call_missed":
          handleCallMissedWrap(dm, myPubkey);
          return;
        case "media_key":
          // Frame-E2EE sender key for a LiveKit room we are in (docs/E2EE_CALLS.md).
          // Never rendered; the active E2EE session picks it up (or nobody does).
          if (dm.sender !== myPubkey) deliverMediaKey(dm.sender, w.envelope, dm.wrapId);
          return;
        case "edit":
          dispatch(
            editDMMessage({
              partnerPubkey: w.conversationId,
              rumorId: w.targetRumorId,
              newContent: w.content,
              editedAt: nowSec,
              senderPubkey: dm.sender,
              wrapId: dm.wrapId,
            }),
          );
          return;
        case "delete":
          dispatch(
            remoteDeleteDMMessage({
              partnerPubkey: w.conversationId,
              rumorId: w.targetRumorId,
              senderPubkey: dm.sender,
              wrapId: dm.wrapId,
            }),
          );
          return;
        case "reaction":
          dispatch(
            reactDMMessage({
              partnerPubkey: w.conversationId,
              rumorId: w.targetRumorId,
              emoji: w.emoji,
              reactorPubkey: dm.sender,
              wrapId: dm.wrapId,
            }),
          );
          return;
        case "reaction_remove":
          dispatch(
            removeDMReaction({
              partnerPubkey: w.conversationId,
              rumorId: w.targetRumorId,
              emoji: w.emoji,
              reactorPubkey: dm.sender,
              wrapId: dm.wrapId,
            }),
          );
          return;
        case "typing":
          // Judged by the rumor's own age, not the wrap's expiration: expiry
          // carries a 60 s skew allowance (WRAP_EXPIRY_SKEW_SEC), which must
          // not turn a stale typing wrap into a phantom "typing…".
          if (nowSec - dm.createdAt > DM_EXPIRATION_SECONDS.typing) return;
          if (dm.sender !== myPubkey) {
            dispatch(setTyping({ conversationId: w.conversationId, pubkey: dm.sender, until: nowSec + 6 }));
          }
          return;
        case "receipt":
          if (dm.sender !== myPubkey) {
            dispatch(
              applyReceipt({
                conversationId: w.conversationId,
                rumorIds: w.rumorIds,
                status: w.status,
                from: dm.sender,
                wrapId: dm.wrapId,
              }),
            );
          }
          return;
        case "text":
        case "file":
          break;
      }

      const isOwnMessage = dm.sender === myPubkey;
      const partnerPubkey = w.conversationId;

      // Reject if the 1:1 partner pubkey is invalid (corrupted decryption
      // artifact). Room ids are a `g` value or a sorted-participant key.
      if (!w.isRoom && (!HEX64_RE.test(partnerPubkey) || (partnerPubkey === myPubkey && !isOwnMessage))) {
        return;
      }

      // Snapshot DM state BEFORE dispatch so we can gate the notification on
      // whether this wrap was already processed (e.g. restored from IndexedDB).
      const dmState = getState().dm;
      const alreadyProcessed = !!dmState.processedWrapIdSet[dm.wrapId];

      // NIP-17: the rumor's created_at IS the real send time.
      // Only the seal and gift wrap timestamps are randomized for privacy.
      const displayTimestamp = dm.createdAt;

      dispatch(
        addDMMessage({
          partnerPubkey,
          myPubkey,
          message: {
            id: dm.wrapId,
            senderPubkey: dm.sender,
            content: w.type === "text" ? w.content : "",
            createdAt: displayTimestamp,
            wrapId: dm.wrapId,
            rumorId: dm.rumorId,
            replyToWrapId: w.replyTo,
            emojiTags: w.type === "text" && w.emojiTags.length > 0 ? w.emojiTags : undefined,
            kind: w.type === "file" ? 15 : 14,
            attachment: w.type === "file" ? w.file : undefined,
            wrapCreatedAt: event.created_at,
            expiresAt: w.expiration,
          },
          room: w.isRoom ? { participants: w.participants, subject: w.subject } : undefined,
        }),
      );

      if (!isOwnMessage && !alreadyProcessed) {
        // Delivered receipt (friends only, batched; docs/DM_WIRE_CONTRACT.md §2).
        queueDeliveredReceipt(partnerPubkey, dm.rumorId);
        // Only fire notification for genuinely new incoming messages that we're
        // not currently viewing. Prevents spurious notifications on app reload
        // when old wraps are re-fetched from relays.
        if (dmState.activeConversation !== partnerPubkey) {
          evaluateDMNotification(dm.sender, w.type === "text" ? w.content : "Sent an attachment");
        }
      }
    } catch {
      // Routing failed on a decrypted wrap — a malformed rumor, not a transient.
    }
  }

  /** Handle a shared-project key DM (kind 20017): validate, then keychain only.
   *  Every delivery is checked again (the store answers "known" / "forgotten"
   *  cheaply). The wrap is marked processed, which stops the NIP-77 reconcile
   *  re-requesting it, only where the key outlives a restart (OS keychain, or the
   *  web persistence opt-in): web session memory loses keys on reload, and the
   *  replayed wrap is how they come back. A failed keychain write stays unmarked. */
  function handleProjectKeyWrap(dm: UnwrappedDM, myPubkey: string): void {
    const markProcessed = () => {
      if (isSecretPersistEnabled() && getState().identity.pubkey === myPubkey) {
        dispatch(markDMWrapProcessed(dm.wrapId));
      }
    };
    const grant = parseProjectKeyDM(dm, myPubkey);
    if (!grant) {
      markProcessed();
      return;
    }
    receiveProjectKey(grant, myPubkey).then(markProcessed).catch(() => {});
  }

  return { handleGiftWrap };
}
