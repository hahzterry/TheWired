import { useEffect } from "react";
import { useAppSelector } from "@/store/hooks";
import { selectFeatureEnabled, FEATURE_E2EE_SPACES } from "@/store/slices/featuresSlice";
import { resetSpaceE2eeRecord } from "./e2eeRecord";

/**
 * Encrypted spaces for the logged-in account. Mounted once at the app root.
 *
 * Whether a space is encrypted is decided from its id (spaceIdFormat.ts), so
 * nothing needs loading for the guards. The rest (the record, keys,
 * subscriptions, the codec) loads only when the feature is on, off the
 * startup path, and restarts on account switch so no key outlives its
 * account.
 */
export function useSpaceE2ee(): void {
  const pubkey = useAppSelector((s) => s.identity.pubkey);
  const enabled = useAppSelector(selectFeatureEnabled(FEATURE_E2EE_SPACES));

  useEffect(() => {
    resetSpaceE2eeRecord();
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
