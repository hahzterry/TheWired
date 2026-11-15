import { useEffect } from "react";
import { useAppSelector } from "@/store/hooks";
import { startSpaceE2ee, stopSpaceE2ee } from "./e2eeController";

/** Run the encrypted-spaces controller for the logged-in account. Mounted once
 *  at the app root; restarts on account switch so no key outlives its account. */
export function useSpaceE2ee(): void {
  const pubkey = useAppSelector((s) => s.identity.pubkey);
  useEffect(() => {
    if (!pubkey) return;
    startSpaceE2ee();
    return () => stopSpaceE2ee();
  }, [pubkey]);
}
