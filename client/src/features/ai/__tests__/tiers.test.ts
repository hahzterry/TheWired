import { describe, it, expect } from "vitest";
import type { AIProviderConfig, AIProviderStatus } from "@/types/ai";
import {
  MANAGED_PROVIDER_ID,
  isLoopbackUrl,
  pickDefaultProvider,
  providerTier,
} from "../engine/tiers";

const ollama: AIProviderConfig = {
  id: "ollama",
  kind: "openai-compat",
  label: "Ollama (local)",
  baseUrl: "http://localhost:11434/v1",
  keyRequired: false,
  defaultModel: "llama3.2",
};
const lmstudio: AIProviderConfig = {
  id: "lms",
  kind: "openai-compat",
  label: "LM Studio (local)",
  baseUrl: "http://127.0.0.1:1234/v1",
  keyRequired: false,
  defaultModel: "qwen-local",
};
const managed: AIProviderConfig = {
  id: MANAGED_PROVIDER_ID,
  kind: "local-llama",
  label: "Built-in engine",
  baseUrl: "http://127.0.0.1:51234/v1",
  keyRequired: false,
  defaultModel: "qwen2.5-1.5b-instruct-q4",
};
const openai: AIProviderConfig = {
  id: "openai",
  kind: "openai-compat",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  keyRequired: true,
  defaultModel: "gpt-x",
};
const claude: AIProviderConfig = {
  id: "claude",
  kind: "anthropic",
  label: "Anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  keyRequired: true,
  defaultModel: "claude-x",
};

const connected: AIProviderStatus = { status: "connected", lastError: null };
const offline: AIProviderStatus = { status: "error", lastError: "Unreachable" };

function statuses(...ids: string[]): Record<string, AIProviderStatus> {
  return Object.fromEntries(ids.map((id) => [id, connected]));
}

describe("providerTier", () => {
  it("ranks installed local engines first, the built-in engine second, cloud third", () => {
    expect(providerTier(ollama)).toBe(1);
    expect(providerTier(lmstudio)).toBe(1);
    expect(providerTier(managed)).toBe(2);
    expect(providerTier(openai)).toBe(3);
    expect(providerTier(claude)).toBe(3);
  });

  it("puts the built-in engine in tier 2 even though it is on loopback", () => {
    // Its baseUrl is 127.0.0.1 too; the kind / reserved id is what marks it.
    expect(isLoopbackUrl(managed.baseUrl)).toBe(true);
    expect(providerTier(managed)).toBe(2);
    expect(providerTier({ ...managed, id: "other-id" })).toBe(2);
    expect(providerTier({ ...managed, kind: "openai-compat" })).toBe(2);
  });

  it("treats only real loopback hosts as local", () => {
    expect(isLoopbackUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLoopbackUrl("http://LOCALHOST:1/v1")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:1234")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8080/v1")).toBe(true);
    // Lookalikes and remote hosts are cloud-tier.
    expect(isLoopbackUrl("https://localhost.evil.example/v1")).toBe(false);
    expect(isLoopbackUrl("https://127.0.0.1.evil.example/v1")).toBe(false);
    expect(isLoopbackUrl("http://192.168.1.20:11434/v1")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(providerTier({ ...openai, baseUrl: "" })).toBe(3);
  });
});

describe("pickDefaultProvider — tier order", () => {
  it("prefers a connected installed engine over the built-in engine and cloud", () => {
    // Insertion order is deliberately worst-first.
    const pick = pickDefaultProvider(
      [openai, managed, ollama],
      statuses("openai", MANAGED_PROVIDER_ID, "ollama"),
      {},
    );
    expect(pick).toEqual({ providerId: "ollama", model: "llama3.2" });
  });

  it("prefers the running built-in engine over cloud when no local engine is installed", () => {
    const pick = pickDefaultProvider(
      [claude, openai, managed],
      statuses("claude", "openai", MANAGED_PROVIDER_ID),
      {},
    );
    expect(pick).toEqual({ providerId: MANAGED_PROVIDER_ID, model: "qwen2.5-1.5b-instruct-q4" });
  });

  it("falls to cloud when it is the only tier present", () => {
    const pick = pickDefaultProvider([claude, openai], statuses("claude", "openai"), {});
    expect(pick).toEqual({ providerId: "claude", model: "claude-x" });
  });

  it("keeps the given order within a tier", () => {
    const pick = pickDefaultProvider([lmstudio, ollama], statuses("lms", "ollama"), {});
    expect(pick?.providerId).toBe("lms");
  });
});

describe("pickDefaultProvider — fallbacks", () => {
  it("skips a tier whose engine is not answering and uses the next one", () => {
    // Ollama configured but its daemon is down → the built-in engine.
    const pick = pickDefaultProvider(
      [ollama, managed, openai],
      { ollama: offline, [MANAGED_PROVIDER_ID]: connected, openai: connected },
      {},
    );
    expect(pick?.providerId).toBe(MANAGED_PROVIDER_ID);
  });

  it("uses cloud while the built-in engine is installed but stopped", () => {
    // A stopped engine is not "connected"; something that works now wins.
    const pick = pickDefaultProvider(
      [managed, openai],
      { [MANAGED_PROVIDER_ID]: { status: "unknown", lastError: null }, openai: connected },
      {},
    );
    expect(pick?.providerId).toBe("openai");
  });

  it("offers the stopped built-in engine when nothing else is connected (it starts on use)", () => {
    const pick = pickDefaultProvider(
      [openai, managed],
      { openai: offline, [MANAGED_PROVIDER_ID]: { status: "unknown", lastError: null } },
      {},
    );
    expect(pick).toEqual({ providerId: MANAGED_PROVIDER_ID, model: "qwen2.5-1.5b-instruct-q4" });
  });

  it("with nothing connected at all, still orders the untested candidates by tier", () => {
    const pick = pickDefaultProvider([openai, managed, ollama], {}, {});
    expect(pick?.providerId).toBe("ollama");
  });

  it("takes a connected provider's first advertised model when it has no default", () => {
    const bare = { ...ollama, defaultModel: undefined };
    const pick = pickDefaultProvider(
      [bare],
      { ollama: { status: "connected", lastError: null, models: [{ id: "phi" }, { id: "x" }] } },
      {},
    );
    expect(pick).toEqual({ providerId: "ollama", model: "phi" });
  });

  it("returns null when no provider has any usable model", () => {
    expect(pickDefaultProvider([], {}, {})).toBeNull();
    expect(
      pickDefaultProvider([{ ...openai, defaultModel: undefined }], statuses("openai"), {}),
    ).toBeNull();
  });
});

describe("pickDefaultProvider — the user's saved default", () => {
  it("wins over every tier", () => {
    const pick = pickDefaultProvider(
      [ollama, managed, openai],
      statuses("ollama", MANAGED_PROVIDER_ID, "openai"),
      { defaultProviderId: "openai", defaultModel: "gpt-chosen" },
    );
    expect(pick).toEqual({ providerId: "openai", model: "gpt-chosen" });
  });

  it("can be the built-in engine while it is stopped", () => {
    const pick = pickDefaultProvider(
      [managed, openai],
      { openai: connected },
      { defaultProviderId: MANAGED_PROVIDER_ID, defaultModel: "qwen3-4b-q4" },
    );
    expect(pick).toEqual({ providerId: MANAGED_PROVIDER_ID, model: "qwen3-4b-q4" });
  });

  it("is ignored once that provider is gone (e.g. the model was deleted)", () => {
    const pick = pickDefaultProvider(
      [openai],
      statuses("openai"),
      { defaultProviderId: MANAGED_PROVIDER_ID, defaultModel: "qwen3-4b-q4" },
    );
    expect(pick).toEqual({ providerId: "openai", model: "gpt-x" });
  });
});
