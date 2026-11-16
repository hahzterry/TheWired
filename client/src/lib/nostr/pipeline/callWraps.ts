import { DM_EXPIRATION_SECONDS } from "@ishtarservices/shared-types";
import { setIncomingCall, missedCall, endCall, addProcessedCallWrapId } from "../../../store/slices/callSlice";
import type { CallType, CallTransport, CallCaps } from "../../../types/calling";
import { createLogger, shortKey } from "../../debug/logger";
import type { PipelineContext } from "./types";

const callLog = createLogger("call");

/**
 * 1:1 call signalling that arrives inside gift wraps: invite, decline, missed.
 * Called by the gift-wrap handler once a rumor is parsed.
 *
 * The body is the code as it stood inside `createEventPipeline`.
 */
export function createCallWrapHandlers(ctx: PipelineContext) {
  const { dispatch, getState } = ctx;

  /**
   * Calls use persistent gift wraps (kind:1059) for signalling because ephemeral
   * kinds aren't available for E2E-encrypted DMs. Relays keep those wraps forever,
   * so every client reconnect replays them. A call is only valid for seconds, so
   * anything older than this window is stale noise — suppress it.
   *
   * Tracks the wire TTL rather than undercutting it. At 60s this gate dropped
   * call traffic that was still live by the wrap's own `expiration`, so a peer
   * on the 120s contract could ring (or cancel) inside a window where we stayed
   * silent — a cross-client asymmetry with no upside, since the relay already
   * drops anything past the expiration via NIP-40.
   */
  const CALL_WRAP_MAX_AGE_SEC = DM_EXPIRATION_SECONDS.call;

  function isCallWrapFresh(createdAt: number | undefined): boolean {
    if (typeof createdAt !== "number") return false;
    const nowSec = Math.round(Date.now() / 1000);
    return nowSec - createdAt <= CALL_WRAP_MAX_AGE_SEC;
  }

  /** Handle an incoming call invitation from a gift wrap */
  function handleCallInviteWrap(
    dm: { sender: string; content: string; tags: string[][]; wrapId: string; createdAt?: number },
    myPubkey: string,
  ): void {
    const isOwnMessage = dm.sender === myPubkey;
    if (isOwnMessage) return; // Ignore our own outgoing invites

    const callState = getState().call;

    // Dedup: never re-ring on the same wrap (survives reload / user switch via IDB).
    if (callState.processedWrapIds.includes(dm.wrapId)) return;
    dispatch(addProcessedCallWrapId(dm.wrapId));

    // Drop stale invites resurfaced from relay storage on reconnect.
    if (!isCallWrapFresh(dm.createdAt)) return;

    // Don't accept calls if we already have an active call
    if (callState.activeCall || callState.incomingCall) return;

    try {
      const payload = JSON.parse(dm.content) as {
        roomSecretKey: string;
        callType: CallType;
        callerName?: string;
        transport?: CallTransport;
        caps?: CallCaps;
      };

      callLog.info(
        `incoming invite from=${shortKey(dm.sender)} type=${payload.callType} transport=${payload.transport ?? "legacy"} e2ee=${payload.caps?.e2ee === true}`,
      );
      if (payload.caps?.e2ee !== true) {
        // The caller will not frame-encrypt (older desktop build, or a mobile
        // build without media). Calls are E2EE-only: don't ring, decline so
        // their ringing stops, and show who needs to update.
        callLog.warn(`invite from ${shortKey(dm.sender)} has no e2ee capability — declining`);
        void import("../../../features/calling/callService")
          .then((m) => m.declineLegacyInvite(dm.sender))
          .catch((err) => console.warn("[call] could not decline legacy invite:", err));
        return;
      }

      dispatch(
        setIncomingCall({
          callerPubkey: dm.sender,
          roomSecretKey: payload.roomSecretKey,
          callType: payload.callType,
          callerName: payload.callerName ?? dm.sender,
          timestamp: Date.now(),
          transport: payload.transport,
          caps: { e2ee: true },
        }),
      );
    } catch {
      console.warn("[call] Failed to parse call invite");
    }
  }

  /** Handle a call decline notification — the remote party declined our outgoing call */
  function handleCallDeclineWrap(
    dm: { sender: string; content: string; tags: string[][]; wrapId: string; createdAt?: number },
    myPubkey: string,
  ): void {
    const isOwnMessage = dm.sender === myPubkey;
    if (isOwnMessage) return;

    const callState = getState().call;
    if (callState.processedWrapIds.includes(dm.wrapId)) return;
    dispatch(addProcessedCallWrapId(dm.wrapId));
    if (!isCallWrapFresh(dm.createdAt)) return;

    if (callState.activeCall?.partnerPubkey === dm.sender) {
      dispatch(endCall("declined"));
    }
  }

  /** Handle a missed call notification */
  function handleCallMissedWrap(
    dm: { sender: string; content: string; tags: string[][]; wrapId: string; createdAt?: number },
    myPubkey: string,
  ): void {
    const isOwnMessage = dm.sender === myPubkey;
    if (isOwnMessage) return;

    const callState = getState().call;
    if (callState.processedWrapIds.includes(dm.wrapId)) return;
    dispatch(addProcessedCallWrapId(dm.wrapId));
    if (!isCallWrapFresh(dm.createdAt)) return;

    if (callState.incomingCall?.callerPubkey === dm.sender) {
      dispatch(missedCall());
    }
  }

  return { handleCallInviteWrap, handleCallDeclineWrap, handleCallMissedWrap };
}
