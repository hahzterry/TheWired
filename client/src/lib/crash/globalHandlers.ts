/**
 * Global capture for errors that never reach a React error boundary: throws in
 * event handlers, timers, async code and rejected promises nobody awaited.
 *
 * Capture only. The handlers never call `preventDefault`, so the browser's own
 * console reporting is unchanged, and they never surface UI: an unhandled
 * rejection in a background task is not a reason to interrupt the user.
 */
import { flushCrashLog, recordCrash } from "./crashLog";

/**
 * Noise that is not a crash:
 * - ResizeObserver loop notices are benign and fire constantly on some layouts.
 * - "Script error." is a cross-origin script failure with no usable detail.
 */
const IGNORED_MESSAGES = [/^ResizeObserver loop/i, /^Script error\.?$/i];

function isIgnoredMessage(message: unknown): boolean {
  return typeof message === "string" && IGNORED_MESSAGES.some((re) => re.test(message));
}

/** An aborted fetch or a superseded request is control flow, not a failure. */
function isAbort(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { name?: unknown }).name === "AbortError"
  );
}

function onError(event: ErrorEvent): void {
  if (isIgnoredMessage(event.message)) return;
  // `event.error` is null for cross-origin scripts and some engine-level
  // errors. Fall back to a synthetic Error built from the message so the
  // record still says what happened; `recordCrash` redacts it either way.
  const thrown: unknown = event.error ?? new Error(event.message || "Unknown error");
  if (isAbort(thrown)) return;
  recordCrash(thrown, { source: "window.error" });
}

function onUnhandledRejection(event: PromiseRejectionEvent): void {
  const reason: unknown = event.reason;
  if (isAbort(reason)) return;
  if (reason instanceof Error && isIgnoredMessage(reason.message)) return;
  recordCrash(reason, { source: "unhandledrejection" });
}

function onVisibilityChange(): void {
  if (document.visibilityState === "hidden") flushCrashLog();
}

let installed = false;

/** Install the window-level handlers. Idempotent; returns an uninstall function. */
export function installGlobalErrorHandlers(): () => void {
  if (typeof window === "undefined") return () => {};
  if (!installed) {
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    // Storage writes are coalesced; make sure a queued one lands before the
    // page is hidden or discarded.
    window.addEventListener("pagehide", flushCrashLog);
    document.addEventListener("visibilitychange", onVisibilityChange);
    installed = true;
  }
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    window.removeEventListener("pagehide", flushCrashLog);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    installed = false;
  };
}
