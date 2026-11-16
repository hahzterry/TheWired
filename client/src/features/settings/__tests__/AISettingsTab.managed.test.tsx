import { describe, it, expect, afterEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { createTestStore } from "@/__tests__/helpers/createTestStore";
import {
  setManagedHardware,
  setManagedModels,
  setManagedStatus,
  upsertProviderConfig,
} from "@/store/slices/aiSlice";
import { MANAGED_PROVIDER_ID } from "@/features/ai/engine/tiers";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => tauri.invoke(...args),
  Channel: class {},
}));
vi.mock("@/features/ai/engine/llmManager", () => ({
  upsertProvider: vi.fn(),
  removeProvider: vi.fn(),
  testProvider: vi.fn(),
  detectAndAddLocalEngines: vi.fn(async () => 0),
  registerManagedProvider: vi.fn(),
  unregisterManagedProvider: vi.fn(),
}));
vi.mock("@/features/ai/tools/webSearch", () => ({
  WEB_SEARCH_PROVIDERS: [{ id: "tavily", label: "Tavily", keyHint: "" }],
  getWebSearchProvider: () => ({ id: "tavily", label: "Tavily", keyHint: "" }),
  setWebSearchKey: vi.fn(),
  getWebSearchKey: () => null,
}));

import { AISettingsTab } from "../AISettingsTab";

const GIB = 1024 ** 3;

function seededStore() {
  const store = createTestStore();
  store.dispatch(
    setManagedHardware({
      os: "macos",
      arch: "aarch64",
      totalRamBytes: 16 * GIB,
      cpuCores: 8,
      freeDiskBytes: 100e9,
      acceleration: "metal",
      engineSupported: true,
      engineBuild: "b12359",
      engineDownloadBytes: 16_907_811,
    }),
  );
  store.dispatch(
    setManagedStatus({
      phase: "running",
      modelId: "qwen2.5-1.5b-instruct-q4",
      restarts: 0,
      error: null,
      engineInstalled: true,
      engineBuild: "b12359",
    }),
  );
  store.dispatch(
    setManagedModels([
      {
        id: "qwen2.5-1.5b-instruct-q4",
        name: "Qwen2.5 1.5B Instruct",
        description: "Small and fast.",
        source: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
        license: "Apache-2.0",
        sizeBytes: 1_117_320_736,
        minRamBytes: 4 * GIB,
        recommendedRamBytes: 8 * GIB,
        reasoning: false,
        installed: true,
        partialBytes: 0,
      },
    ]),
  );
  store.dispatch(
    upsertProviderConfig({
      id: MANAGED_PROVIDER_ID,
      kind: "local-llama",
      label: "Built-in engine",
      baseUrl: "http://built-in-engine.invalid/v1",
      keyRequired: false,
      defaultModel: "qwen2.5-1.5b-instruct-q4",
    }),
  );
  store.dispatch(
    upsertProviderConfig({
      id: "ollama",
      kind: "openai-compat",
      label: "Ollama (local)",
      baseUrl: "http://localhost:11434/v1",
      keyRequired: false,
    }),
  );
  return store;
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  tauri.invoke.mockClear();
});

describe("AISettingsTab — built-in engine tier", () => {
  it("REGRESSION: the web build hides the tier entirely and calls nothing native", () => {
    // No __TAURI_INTERNALS__: this is the browser build. Even if managed state
    // somehow existed, none of it may render and no IPC may be attempted.
    renderWithProviders(<AISettingsTab />, { store: seededStore() });
    expect(screen.queryByText("Built-in engine")).toBeNull();
    expect(screen.queryByText("Engine runtime")).toBeNull();
    expect(screen.queryByText("Qwen2.5 1.5B Instruct")).toBeNull();
    expect(screen.queryByRole("button", { name: /Stop engine/ })).toBeNull();
    // The rest of the tab is intact.
    expect(screen.getByText("AI Engines")).toBeInTheDocument();
    expect(screen.getByText("Ollama (local)")).toBeInTheDocument();
    expect(screen.getByText(/keys are kept in memory for this session only/)).toBeInTheDocument();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("the desktop build shows the tier above the provider list", () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    renderWithProviders(<AISettingsTab />, { store: seededStore() });
    const heading = screen.getByRole("heading", { name: "Built-in engine" });
    const engines = screen.getByRole("heading", { name: "AI Engines" });
    expect(heading.compareDocumentPosition(engines) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Qwen2.5 1.5B Instruct")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop engine" })).toBeInTheDocument();
  });

  it("the built-in engine is not listed as an editable provider card", () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    renderWithProviders(<AISettingsTab />, { store: seededStore() });
    // Exactly one provider card (Ollama): one Remove button, and the engine's
    // placeholder address is not shown as a provider endpoint.
    expect(screen.getAllByRole("button", { name: /Remove/ })).toHaveLength(1);
    expect(screen.queryByText("http://built-in-engine.invalid/v1")).toBeNull();
    expect(screen.queryByText("local-llama")).toBeNull();
  });
});
