/**
 * Fallbacks for the call overlays.
 *
 * A call is live state outside React: when the call view fails to render, the
 * microphone is still open and the other side can still hear you. A generic
 * "couldn't be displayed" row would leave the user in a call they cannot see
 * or end. These fallbacks keep the controls that matter, wired straight to the
 * call service and the store, with nothing from the failed component involved.
 */
import { useEffect } from "react";
import { Mic, MicOff, Phone, PhoneOff, RotateCcw } from "lucide-react";
import { CopyDiagnosticsButton } from "@/components/ui/ErrorBoundary";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { toggleCallMute } from "@/store/slices/callSlice";
import { hangupCall, setCallMuted } from "./callService";
import { startRinging, stopRinging } from "./callRingtone";
import { useCall } from "./useCall";

const ROUND_BUTTON =
  "flex h-10 w-10 shrink-0 items-center justify-center rounded-full shadow transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const TEXT_BUTTON =
  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-soft transition-colors hover:bg-surface-hover hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

interface CallFallbackProps {
  /** Re-mount the real call UI. */
  onRetry: () => void;
}

/** Shown in place of the active-call view when it fails to render. */
export function ActiveCallFallback({ onRetry }: CallFallbackProps) {
  const dispatch = useAppDispatch();
  const activeCall = useAppSelector((s) => s.call.activeCall);
  if (!activeCall) return null;

  const muted = activeCall.isMuted;

  // Same sequence as the real controls: flip the flag, apply it to the
  // transmitted audio, and revert the flag if that fails.
  const toggleMute = async () => {
    dispatch(toggleCallMute());
    try {
      await setCallMuted(!muted);
    } catch {
      dispatch(toggleCallMute());
    }
  };

  const endCall = () => {
    hangupCall().catch((err: unknown) => console.error("[call] Failed to hangup:", err));
  };

  return (
    <div
      role="alert"
      data-boundary-fallback="call"
      className="fixed bottom-4 right-4 z-40 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-2xl border border-border card-glass px-4 py-3 shadow-xl"
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold text-heading">Call in progress</div>
        <div className="text-xs text-muted">
          The call view couldn't be displayed. You are still connected
          {muted ? " and muted." : "."}
        </div>
        <div className="mt-1 flex items-center gap-1">
          <button type="button" onClick={onRetry} className={TEXT_BUTTON}>
            <RotateCcw size={12} />
            Show call
          </button>
          <CopyDiagnosticsButton appearance="icon" />
        </div>
      </div>
      <button
        type="button"
        onClick={toggleMute}
        aria-pressed={muted}
        aria-label={muted ? "Unmute" : "Mute"}
        title={muted ? "Unmute" : "Mute"}
        className={`${ROUND_BUTTON} ${muted ? "bg-red-500/20 text-red-400 hover:bg-red-500/30" : "bg-surface text-heading hover:bg-surface-hover"}`}
      >
        {muted ? <MicOff size={18} /> : <Mic size={18} />}
      </button>
      <button
        type="button"
        onClick={endCall}
        aria-label="End call"
        title="End call"
        className={`${ROUND_BUTTON} bg-red-500 text-white hover:bg-red-600`}
      >
        <PhoneOff size={18} />
      </button>
    </div>
  );
}

/** Shown in place of the incoming-call banner when it fails to render. */
export function IncomingCallFallback({ onRetry }: CallFallbackProps) {
  const incomingCall = useAppSelector((s) => s.call.incomingCall);
  const { answer, reject } = useCall();
  const ringing = !!incomingCall;

  // The banner owns the ringtone and takes it with it when it fails. Keep
  // ringing, or the user has no cue that a call is waiting.
  useEffect(() => {
    if (!ringing) return;
    startRinging();
    return () => stopRinging();
  }, [ringing]);

  if (!incomingCall) return null;

  return (
    <div
      role="alert"
      data-boundary-fallback="incoming-call"
      className="fixed right-4 top-16 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-2xl border border-border card-glass px-4 py-3 shadow-xl"
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold text-heading">Incoming call</div>
        <div className="text-xs text-muted">The caller's details couldn't be displayed.</div>
        <div className="mt-1 flex items-center gap-1">
          <button type="button" onClick={onRetry} className={TEXT_BUTTON}>
            <RotateCcw size={12} />
            Retry
          </button>
          <CopyDiagnosticsButton appearance="icon" />
        </div>
      </div>
      <button
        type="button"
        onClick={reject}
        aria-label="Decline"
        title="Decline"
        className={`${ROUND_BUTTON} bg-red-500 text-white hover:bg-red-600`}
      >
        <PhoneOff size={18} />
      </button>
      <button
        type="button"
        onClick={answer}
        aria-label="Accept"
        title="Accept"
        className={`${ROUND_BUTTON} bg-green-500 text-white hover:bg-green-600`}
      >
        <Phone size={18} />
      </button>
    </div>
  );
}
