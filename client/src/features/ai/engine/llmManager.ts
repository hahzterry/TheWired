/**
 * Module-singleton owner of every LLM provider client for the active account.
 * Mirrors `features/wallet/walletManager.ts`: API keys stay in memory + the OS
 * keychain and NEVER enter Redux. The slice carries only non-secret config
 * (baseUrl/label/model) + connection status. Dispatches directly to the store so
 * login, settings, and the chat path share one source of truth.
 */
import { nanoid } from "nanoid";
import { store } from "@/store";
import {
  setProviders,
  upsertProviderConfig,
  removeProviderConfig,
  patchProviderStatus,
  setProviderModels,
  clearProviderStatus,
} from "@/store/slices/aiSlice";
import {
  getSecret,
  setSecret,
  deleteSecret,
  llmProvidersKey,
  llmApiKeySecret,
} from "@/lib/nostr/secretStore";
import type { AIModelInfo, AIProviderConfig } from "@/types/ai";
import type { LLMProvider } from "./types";
import { makeOpenAICompatProvider } from "./providers/openaiCompat";
import { makeAnthropicProvider } from "./providers/anthropic";
import { detectLocalEngines } from "./detectLocal";
import { MANAGED_PROVIDER_ID, pickDefaultProvider } from "./tiers";

const providers = new Map<string, LLMProvider>();
const apiKeys = new Map<string, string>(); // id → key (kept here, NEVER in Redux)
const configs = new Map<string, AIProviderConfig>();
let activePubkey: string | null = null;
/**
 * Bumped by every load and reset. Async paths re-check it after EVERY await and
 * bail when superseded — otherwise a load still in flight across an account
 * switch seeds the previous account's providers and API keys into the next
 * account's session (and a later persist writes them into its keychain blob) —
 * audit #49. Also kills in-flight test/refresh probes after a reset (#96).
 */
let generation = 0;

interface StoredConfig {
  providers: AIProviderConfig[];
}

function buildProvider(config: AIProviderConfig): LLMProvider {
  const getKey = () => apiKeys.get(config.id) ?? null;
  switch (config.kind) {
    case "anthropic":
      return makeAnthropicProvider(config, getKey);
    case "openai-compat":
    case "local-llama":
    default:
      // Image/audio/rust-inproc engines slot in here in later phases.
      return makeOpenAICompatProvider(config, getKey);
  }
}

async function persistConfigs(): Promise<void> {
  if (!activePubkey) return;
  // The built-in engine is runtime state, never a stored provider: its address
  // and key change on every launch.
  const list = [...configs.values()].filter((c) => c.id !== MANAGED_PROVIDER_ID);
  if (list.length === 0) {
    await deleteSecret(llmProvidersKey(activePubkey));
    return;
  }
  const blob: StoredConfig = { providers: list };
  await setSecret(llmProvidersKey(activePubkey), JSON.stringify(blob));
}

function syncReduxConfigs(): void {
  store.dispatch(setProviders([...configs.values()]));
}

/** Load every stored provider for the active account (on login / account switch). */
export async function loadProvidersForAccount(pubkey: string): Promise<void> {
  const gen = ++generation; // supersede any load still in flight (audit #49)
  activePubkey = pubkey;
  providers.clear();
  apiKeys.clear();
  configs.clear();
  managedTransport = null;

  const raw = await getSecret(llmProvidersKey(pubkey));
  if (gen !== generation) return; // superseded while reading the blob
  if (raw) {
    try {
      const blob = JSON.parse(raw) as StoredConfig;
      for (const config of blob.providers ?? []) {
        if (config.id === MANAGED_PROVIDER_ID) continue; // reserved id
        configs.set(config.id, config);
        if (config.keyRequired) {
          const key = await getSecret(llmApiKeySecret(pubkey, config.id));
          if (gen !== generation) return; // superseded mid-keychain-read
          if (key) apiKeys.set(config.id, key);
        }
        providers.set(config.id, buildProvider(config));
      }
    } catch {
      /* corrupt blob — start empty */
    }
  }
  syncReduxConfigs();
  // Verify each provider in the background (populates status + model lists).
  for (const id of configs.keys()) void testProvider(id);
}

/** Add or update a provider. Persists the (optional) key to the keychain. */
export async function upsertProvider(
  input: Omit<AIProviderConfig, "id"> & { id?: string },
  apiKey?: string | null,
): Promise<string> {
  if (!activePubkey) throw new Error("Log in before configuring AI providers.");
  if (input.id === MANAGED_PROVIDER_ID) {
    throw new Error("The built-in engine is managed from Settings → AI.");
  }
  const gen = generation;
  const id = input.id ?? nanoid(8);
  const config: AIProviderConfig = { ...input, id };
  configs.set(id, config);

  if (apiKey !== undefined) {
    const trimmed = apiKey?.trim() ?? "";
    if (trimmed) {
      apiKeys.set(id, trimmed);
      await setSecret(llmApiKeySecret(activePubkey, id), trimmed);
    } else {
      apiKeys.delete(id);
      await deleteSecret(llmApiKeySecret(activePubkey, id));
    }
  }
  // Account switched / reset while the keychain write was in flight: don't
  // re-add this provider to the (now different) session or persist into the
  // wrong account's blob (audit #49).
  if (gen !== generation) return id;

  providers.set(id, buildProvider(config));
  store.dispatch(upsertProviderConfig(config));
  await persistConfigs();
  void testProvider(id);
  return id;
}

export async function removeProvider(id: string): Promise<void> {
  if (id === MANAGED_PROVIDER_ID) return; // owned by managedEngine.ts
  const gen = generation;
  providers.delete(id);
  apiKeys.delete(id);
  configs.delete(id);
  store.dispatch(removeProviderConfig(id));
  if (activePubkey) {
    await deleteSecret(llmApiKeySecret(activePubkey, id));
    if (gen !== generation) return;
    await persistConfigs();
  }
}

/** Detect local engines (Ollama / LM Studio) and add any not already present. */
export async function detectAndAddLocalEngines(): Promise<number> {
  const detected = await detectLocalEngines();
  let added = 0;
  for (const engine of detected) {
    const exists = [...configs.values()].some(
      (c) => c.baseUrl === engine.baseUrl,
    );
    if (exists) continue;
    await upsertProvider({
      kind: "openai-compat",
      label: engine.label,
      baseUrl: engine.baseUrl,
      keyRequired: false,
      defaultModel: engine.models[0]?.id,
    });
    added++;
  }
  return added;
}

export async function testProvider(id: string): Promise<void> {
  const provider = providers.get(id);
  if (!provider) return;
  const gen = generation;
  store.dispatch(
    patchProviderStatus({ providerId: id, patch: { status: "connecting" } }),
  );
  const result = await provider.testConnection();
  // A reset / account switch landed while probing — drop the result instead of
  // repopulating state for a torn-down session (audit #96).
  if (gen !== generation) return;
  if (!result.ok) {
    store.dispatch(
      patchProviderStatus({
        providerId: id,
        patch: { status: "error", lastError: result.error ?? "Unreachable" },
      }),
    );
    return;
  }
  store.dispatch(
    patchProviderStatus({
      providerId: id,
      patch: { status: "connected", lastError: null },
    }),
  );
  void refreshModels(id);
}

export async function refreshModels(id: string): Promise<AIModelInfo[]> {
  const provider = providers.get(id);
  if (!provider) return [];
  const gen = generation;
  try {
    const models = await provider.listModels();
    if (gen !== generation) return [];
    store.dispatch(setProviderModels({ providerId: id, models }));
    return models;
  } catch {
    return [];
  }
}

export function getProvider(id: string): LLMProvider | undefined {
  return providers.get(id);
}

export function getProviderConfig(id: string): AIProviderConfig | undefined {
  return configs.get(id);
}

/** True when a provider requires an API key but none is loaded — used to surface
 *  a clear "add a key" message instead of a raw 401 from the provider. */
export function providerNeedsKey(id: string): boolean {
  const config = configs.get(id);
  return !!config?.keyRequired && !apiKeys.get(id);
}

/**
 * Pick a sensible default provider + model for a new conversation: the user's
 * saved default, else the best engine tier available (installed local engine →
 * built-in engine → cloud). See `tiers.ts`.
 */
export function getDefaultProviderAndModel(): {
  providerId: string;
  model: string;
} | null {
  const ai = store.getState().ai;
  return pickDefaultProvider([...configs.values()], ai.providerStatus, ai.prefs);
}

// --- Built-in (managed) engine ------------------------------------------------
// `managedEngine.ts` talks to the native side and decides WHEN the engine is
// available; this module is the only place its per-launch access key is held.
// The key sits in `apiKeys` next to the cloud keys: memory only, never Redux,
// and (unlike cloud keys) never the keychain either.

let managedTransport: LLMProvider | null = null;

/**
 * Show the built-in engine as a provider (model picker, default selection).
 * `provider` is the facade from `managedEngine.ts` that starts the engine on
 * first use; `connected` reflects whether it is running right now.
 */
export function registerManagedProvider(
  provider: LLMProvider,
  config: Omit<AIProviderConfig, "id" | "kind" | "keyRequired">,
  models: AIModelInfo[],
  connected: boolean,
): void {
  if (!activePubkey) return;
  const full: AIProviderConfig = {
    ...config,
    id: MANAGED_PROVIDER_ID,
    kind: "local-llama",
    // The engine's key is internal: the user is never asked for one.
    keyRequired: false,
  };
  configs.set(MANAGED_PROVIDER_ID, full);
  providers.set(MANAGED_PROVIDER_ID, provider);
  store.dispatch(upsertProviderConfig(full));
  store.dispatch(
    patchProviderStatus({
      providerId: MANAGED_PROVIDER_ID,
      patch: { status: connected ? "connected" : "unknown", lastError: null, models },
    }),
  );
}

export function unregisterManagedProvider(): void {
  setManagedCredentials(null);
  if (!configs.has(MANAGED_PROVIDER_ID) && !providers.has(MANAGED_PROVIDER_ID)) return;
  configs.delete(MANAGED_PROVIDER_ID);
  providers.delete(MANAGED_PROVIDER_ID);
  store.dispatch(removeProviderConfig(MANAGED_PROVIDER_ID));
}

/**
 * Hand over (or drop) the running engine's address and per-launch key. The key
 * goes into the in-memory key map and nowhere else.
 */
export function setManagedCredentials(
  connection: { baseUrl: string; apiKey: string } | null,
): void {
  if (!connection || !activePubkey) {
    apiKeys.delete(MANAGED_PROVIDER_ID);
    managedTransport = null;
    return;
  }
  apiKeys.set(MANAGED_PROVIDER_ID, connection.apiKey);
  managedTransport = makeOpenAICompatProvider(
    {
      id: MANAGED_PROVIDER_ID,
      kind: "local-llama",
      label: "Built-in engine",
      baseUrl: connection.baseUrl,
      keyRequired: false,
    },
    () => apiKeys.get(MANAGED_PROVIDER_ID) ?? null,
  );
}

/** The OpenAI-compatible client for the running engine, or null when stopped. */
export function getManagedTransport(): LLMProvider | null {
  return managedTransport;
}

/** Full teardown: logout, account switch, or the AI feature flag turning off.
 *  Drops decrypted API keys from memory, clears display state, and invalidates
 *  every in-flight load/probe so a late resolution can't repopulate anything
 *  (audit #49/#96). */
export function resetLLMManager(): void {
  generation++;
  providers.clear();
  apiKeys.clear();
  configs.clear();
  managedTransport = null;
  activePubkey = null;
  store.dispatch(setProviders([]));
  store.dispatch(clearProviderStatus());
}
