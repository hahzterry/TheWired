import { evaluateFriendRequestNotification, evaluateFriendAcceptNotification } from "../notificationEvaluator";
import { addFriendRequest, markOutgoingAccepted, applyAcceptWrap, applyRemoveWrap, addProcessedWrapId, clearRemovedPubkey, isStaleAfterRemoval } from "../../../store/slices/friendRequestSlice";
import { addKnownFollower } from "../../../store/slices/identitySlice";
import { acceptFriendRequestAction } from "../friendRequest";
import { followUser } from "../follow";
import type { PipelineContext } from "./types";

/**
 * Friend-request rumors that arrive inside gift wraps: request, accept,
 * removal. Called by the gift-wrap handler once a rumor is parsed.
 *
 * The body is the code as it stood inside `createEventPipeline`, at its
 * original indentation.
 */
export function createFriendWrapHandlers(ctx: PipelineContext) {
  const { dispatch, getState } = ctx;

  type FriendWrap = { sender: string; content: string; tags: string[][]; wrapId: string; createdAt?: number };

  /** The other party of a friend wrap: the sender, or for our own self-wrap
   *  echo the non-self `p` tag. */
  function friendWrapPartner(dm: FriendWrap, myPubkey: string): { partnerPubkey: string; isOwnMessage: boolean } {
    const isOwnMessage = dm.sender === myPubkey;
    const partnerPubkey = isOwnMessage
      ? dm.tags.find((t) => t[0] === "p" && t[1] !== myPubkey)?.[1] ?? dm.sender
      : dm.sender;
    return { partnerPubkey, isOwnMessage };
  }

  /** Rumor timestamp (the wrap's own created_at is randomised per NIP-59). */
  function friendWrapTime(dm: FriendWrap): number {
    return typeof dm.createdAt === "number" ? dm.createdAt : Math.round(Date.now() / 1000);
  }

  /**
   * Shared removal guard. A wrap older than a recorded removal for this partner
   * is a relay replay from a dissolved friendship: mark it processed and drop it.
   * A newer wrap is a genuine new cycle: clear the removal marker so the rows
   * below can be created again. Returns true when the caller should stop.
   */
  function dropIfStaleAfterRemoval(partnerPubkey: string, createdAt: number): boolean {
    const frState = getState().friendRequests;
    if (!frState.removedPubkeys.includes(partnerPubkey)) return false;
    if (isStaleAfterRemoval(frState, partnerPubkey, createdAt)) return true;
    dispatch(clearRemovedPubkey(partnerPubkey));
    return false;
  }

  /** Handle an unwrapped friend request */
  function handleFriendRequestWrap(dm: FriendWrap, myPubkey: string): void {
    const { partnerPubkey, isOwnMessage } = friendWrapPartner(dm, myPubkey);
    const createdAt = friendWrapTime(dm);

    // Dedup check
    if (getState().friendRequests.processedWrapIds.includes(dm.wrapId)) return;

    if (dropIfStaleAfterRemoval(partnerPubkey, createdAt)) {
      dispatch(addProcessedWrapId(dm.wrapId));
      return;
    }

    // NOTE: Do NOT dispatch addProcessedWrapId before addFriendRequest — the
    // reducer tracks the id itself and would short-circuit on a pre-tracked id.

    const direction = isOwnMessage ? "outgoing" : "incoming";
    const frState = getState().friendRequests;

    if (direction === "incoming") {
      // Already friends, or we have a request out to them (spec §Auto-Accept):
      // resolve both rows and confirm with an accept. A request OLDER than the
      // row that already made us friends is a replay of the original — record
      // it and move on rather than reopening a pending card.
      const acceptedRow = frState.requests.find(
        (r) => r.pubkey === partnerPubkey && r.status === "accepted",
      );
      if (acceptedRow && createdAt <= acceptedRow.createdAt) {
        dispatch(addProcessedWrapId(dm.wrapId));
        return;
      }
      const pendingOutgoing = frState.requests.find(
        (r) => r.pubkey === partnerPubkey && r.direction === "outgoing" && r.status === "pending",
      );
      if (acceptedRow || pendingOutgoing) {
        dispatch(
          addFriendRequest({
            id: dm.wrapId,
            pubkey: partnerPubkey,
            message: dm.content,
            createdAt,
            status: "accepted",
            direction: "incoming",
          }),
        );
        dispatch(markOutgoingAccepted(partnerPubkey));
        dispatch(addKnownFollower(partnerPubkey));
        // Send accept back (state is already resolved above)
        acceptFriendRequestAction(partnerPubkey).catch(() => {});
        return;
      }
    }

    dispatch(
      addFriendRequest({
        id: dm.wrapId,
        pubkey: partnerPubkey,
        message: dm.content,
        createdAt,
        status: "pending",
        direction,
      }),
    );

    // Fire notification for incoming only
    if (direction === "incoming") {
      evaluateFriendRequestNotification(partnerPubkey, dm.content);
    }
  }

  /** Handle an unwrapped friend request accept */
  function handleFriendAcceptWrap(dm: FriendWrap, myPubkey: string): void {
    const { partnerPubkey, isOwnMessage } = friendWrapPartner(dm, myPubkey);
    const createdAt = friendWrapTime(dm);

    // Dedup check
    if (getState().friendRequests.processedWrapIds.includes(dm.wrapId)) return;
    dispatch(addProcessedWrapId(dm.wrapId));

    if (dropIfStaleAfterRemoval(partnerPubkey, createdAt)) return;

    // Own self-wrap echo = we accepted THEIR request on another device, so it
    // resolves our incoming row. The peer's accept resolves our outgoing row.
    dispatch(
      applyAcceptWrap({
        pubkey: partnerPubkey,
        direction: isOwnMessage ? "incoming" : "outgoing",
        wrapId: dm.wrapId,
        createdAt,
      }),
    );
    dispatch(addKnownFollower(partnerPubkey));

    // Friendship implies mutual following. The accepting device already follows
    // in acceptFriendRequestAction; the requesting side (and any other device of
    // ours) follows when the accept arrives.
    const currentFollows = getState().identity.followList;
    if (!currentFollows.includes(partnerPubkey)) {
      followUser(partnerPubkey).catch((err) => {
        console.error("[FriendReq] Auto-follow on accept receipt failed:", err);
      });
    }

    if (!isOwnMessage) evaluateFriendAcceptNotification(partnerPubkey);
  }

  /** Handle an unwrapped friend removal notification (the peer's, or our own
   *  self-wrap echo from another device). */
  function handleFriendRemoveWrap(dm: FriendWrap, myPubkey: string): void {
    const { partnerPubkey } = friendWrapPartner(dm, myPubkey);

    // Dedup check
    if (getState().friendRequests.processedWrapIds.includes(dm.wrapId)) return;
    dispatch(addProcessedWrapId(dm.wrapId));

    dispatch(applyRemoveWrap({ pubkey: partnerPubkey, createdAt: friendWrapTime(dm) }));
  }

  return { handleFriendRequestWrap, handleFriendAcceptWrap, handleFriendRemoveWrap };
}
