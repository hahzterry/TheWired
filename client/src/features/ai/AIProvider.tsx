import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { selectFeatureEnabled, FEATURE_AI } from "@/store/slices/featuresSlice";
import { setPrefs } from "@/store/slices/aiSlice";
import {
  loadProvidersForAccount,
  resetLLMManager,
} from "./engine/llmManager";
import { loadConversationsForAccount } from "./conversationActions";
import { loadAIPrefs } from "./aiPrefs";
import { loadWebSearchKey, resetWebSearch } from "./tools/webSearch";
import { abortAllTurns } from "./engine/streamRunner";
import { initManagedEngine, teardownManagedEngine } from "./engine/managedEngine";

/**
 * Effect-only root: loads the active account's AI providers (from the keychain)
 * and conversations (from IndexedDB) when the AI feature is enabled, and tears
 * the provider clients down on logout. Mirrors `WalletProvider`'s login effect.
 */
export function AIProvider() {
  const dispatch = useAppDispatch();
  const pubkey = useAppSelector((s) => s.identity.pubkey);
  const aiEnabled = useAppSelector(selectFeatureEnabled(FEATURE_AI));

  useEffect(() => {
    dispatch(setPrefs(loadAIPrefs()));
  }, [dispatch]);

  useEffect(() => {
    // Any account change (login, logout, switch) must stop in-flight turns first
    // so a late finish can't write the previous account's reply into the new one.
    abortAllTurns();
    if (pubkey && aiEnabled) {
      // The built-in engine registers itself as a provider, so it follows the
      // account's own providers (desktop only; a no-op on the web).
      void loadProvidersForAccount(pubkey).then(() => initManagedEngine());
      void loadConversationsForAccount(pubkey);
      void loadWebSearchKey(pubkey);
    } else {
      // Logout OR the feature flag turning off: quiesce fully — decrypted API
      // keys leave memory and in-flight probes stop dispatching (audit #96).
      // Conversations/prefs are non-secret and persist untouched, matching the
      // Features-tab copy.
      resetLLMManager();
      resetWebSearch();
      // A disabled feature runs nothing: stop the built-in engine too.
      teardownManagedEngine();
    }
  }, [pubkey, aiEnabled]);

  return null;
}
