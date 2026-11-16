import { useEffect } from "react";
import { useAppSelector } from "@/store/hooks";
import { selectFeatureEnabled, FEATURE_E2EE_SPACES } from "@/store/slices/featuresSlice";
import { ensureSpaceE2eeRecord, isSpaceE2eeRecordLoaded, resetSpaceE2eeRecord } from "./e2eeRecord";

/** Pause between attempts to read the record while storage isn't answering. */
const RECORD_RETRY_MS = 10_000;

/**
 * Encrypted spaces for the logged-in account. Mounted once at the app root.
 *
 * The record of which spaces are encrypted is loaded for every account,
 * feature on or off: until it is, the composer and the publish guard refuse to
 * treat any space as ordinary. It is small and has no crypto in it.
 *
 * The rest (keys, subscriptions, the codec) is loaded only when the feature is
 * on, so it stays off the startup path, and restarts on account switch so no
 * key outlives its account.
 */
export function useSpaceE2ee(): void {
  const pubkey = useAppSelector((s) => s.identity.pubkey);
  const enabled = useAppSelector(selectFeatureEnabled(FEATURE_E2EE_SPACES));

  useEffect(() => {
    resetSpaceE2eeRecord();
    if (!pubkey) return;
    // Keep trying while local storage doesn't answer (each attempt settles in
    // a few seconds); a read that answers late loads the record by itself.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const attempt = (): void => {
      ensureSpaceE2eeRecord().catch(() => {
        if (!stopped && !isSpaceE2eeRecordLoaded()) timer = setTimeout(attempt, RECORD_RETRY_MS);
      });
    };
    attempt();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [pubkey]);

  useEffect(() => {
    if (!pubkey || !enabled) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import("./e2eeController").then((controller) => {
      if (cancelled) return;
      controller.startSpaceE2ee();
      stop = controller.stopSpaceE2ee;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [pubkey, enabled]);
}
