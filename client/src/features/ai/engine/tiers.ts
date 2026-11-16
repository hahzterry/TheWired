import type { AIPrefs } from "../aiPrefs";
import type { AIProviderConfig, AIProviderStatus } from "@/types/ai";
import { getPreset } from "./providerCatalog";

/**
 * The three engine tiers, in the order a new chat prefers them when the user
 * has not picked a default:
 *   1. an engine the user already runs (Ollama / LM Studio on loopback),
 *   2. the built-in managed engine,
 *   3. cloud providers (bring your own key).
 * Pure functions over plain data so the order is unit-tested without the
 * provider singleton.
 */
export type EngineTier = 1 | 2 | 3;

/** Fixed id of the built-in engine's provider entry. */
export const MANAGED_PROVIDER_ID = "managed-llama";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function providerTier(config: AIProviderConfig): EngineTier {
  if (config.id === MANAGED_PROVIDER_ID || config.kind === "local-llama") return 2;
  if (isLoopbackUrl(config.baseUrl)) return 1;
  return 3;
}

/** Stable sort by tier: providers in the same tier keep their given order. */
function byTier(configs: AIProviderConfig[]): AIProviderConfig[] {
  return configs
    .map((config, index) => ({ config, index, tier: providerTier(config) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((entry) => entry.config);
}

export interface DefaultChoice {
  providerId: string;
  model: string;
}

/**
 * Pick the provider + model for a new conversation.
 *
 *   1. The user's saved default, when that provider still exists.
 *   2. The best-tier provider that is connected right now.
 *   3. Otherwise the best-tier provider with a known model, even if it has not
 *      answered yet (covers the built-in engine while it is stopped: it starts
 *      on first use).
 */
export function pickDefaultProvider(
  configs: AIProviderConfig[],
  status: Record<string, AIProviderStatus | undefined>,
  prefs: Pick<AIPrefs, "defaultProviderId" | "defaultModel">,
): DefaultChoice | null {
  const prefId = prefs.defaultProviderId;
  const preferred = prefId ? configs.find((c) => c.id === prefId) : undefined;
  if (preferred) {
    const model =
      prefs.defaultModel ?? preferred.defaultModel ?? status[preferred.id]?.models?.[0]?.id;
    if (model) return { providerId: preferred.id, model };
  }

  const ordered = byTier(configs);
  for (const config of ordered) {
    const s = status[config.id];
    if (s?.status !== "connected") continue;
    const model = config.defaultModel ?? s.models?.[0]?.id;
    if (model) return { providerId: config.id, model };
  }
  for (const config of ordered) {
    const model = config.defaultModel ?? getPreset(config.kind)?.defaultModels?.[0];
    if (model) return { providerId: config.id, model };
  }
  return null;
}
