import { store } from "../../../store";
import type { SignerType } from "../../../store/slices/identitySlice";
import { saveUserState, getUserState } from "../../db/userStateStore";
import {
  setAccounts,
  type AccountEntry,
} from "../../../store/slices/identitySlice";

// The persisted multi-account session: its shape and the write at login.

/** Multi-account session format */
export interface MultiAccountSession {
  accounts: AccountEntry[];
  activePubkey: string;
}

/** Legacy session format (pre-multi-account) */
export interface LegacySession {
  pubkey: string;
  signerType: SignerType;
}

export function isMultiAccountSession(s: unknown): s is MultiAccountSession {
  return !!s && typeof s === "object" && "accounts" in s && Array.isArray((s as MultiAccountSession).accounts);
}

/** performLogin step 8: record this account in the multi-account session. */
export async function persistSessionAccount(pubkey: string, storeSignerType: SignerType): Promise<void> {
  // Step 8: Persist multi-account session
  const existingSession = await getUserState<MultiAccountSession>("session");
  const accounts: AccountEntry[] = existingSession?.accounts ?? [];
  const existingIdx = accounts.findIndex((a) => a.pubkey === pubkey);
  const entry: AccountEntry = { pubkey, signerType: storeSignerType, addedAt: Date.now() };
  if (existingIdx >= 0) {
    accounts[existingIdx] = entry;
  } else {
    accounts.push(entry);
  }
  await saveUserState("session", { accounts, activePubkey: pubkey } satisfies MultiAccountSession);
  store.dispatch(setAccounts(accounts));
}
