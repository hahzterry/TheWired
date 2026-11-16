import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "@testing-library/react";

vi.mock("../engine/llmManager", () => ({
  loadProvidersForAccount: vi.fn(async () => {}),
  resetLLMManager: vi.fn(),
}));
vi.mock("../conversationActions", () => ({
  loadConversationsForAccount: vi.fn(async () => {}),
}));
vi.mock("../tools/webSearch", () => ({
  loadWebSearchKey: vi.fn(async () => {}),
  resetWebSearch: vi.fn(),
}));
vi.mock("../engine/streamRunner", () => ({ abortAllTurns: vi.fn() }));
vi.mock("../engine/managedEngine", () => ({
  initManagedEngine: vi.fn(async () => {}),
  teardownManagedEngine: vi.fn(),
}));

import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { login } from "@/store/slices/identitySlice";
import { setFeatureEnabled, FEATURE_AI } from "@/store/slices/featuresSlice";
import { AIProvider } from "../AIProvider";
import { loadProvidersForAccount, resetLLMManager } from "../engine/llmManager";
import { resetWebSearch } from "../tools/webSearch";
import { abortAllTurns } from "../engine/streamRunner";
import { initManagedEngine, teardownManagedEngine } from "../engine/managedEngine";

beforeEach(() => {
  vi.mocked(loadProvidersForAccount).mockClear();
  vi.mocked(resetLLMManager).mockClear();
  vi.mocked(resetWebSearch).mockClear();
  vi.mocked(abortAllTurns).mockClear();
  vi.mocked(initManagedEngine).mockClear();
  vi.mocked(teardownManagedEngine).mockClear();
});

describe("AIProvider lifecycle (audit #96 probe)", () => {
  it("loads providers when logged in with the feature on", () => {
    const { store } = renderWithProviders(<AIProvider />);
    act(() => {
      store.dispatch(login({ pubkey: "me", signerType: "nip07" }));
      store.dispatch(setFeatureEnabled({ feature: FEATURE_AI, enabled: true }));
    });
    expect(loadProvidersForAccount).toHaveBeenCalledWith("me");
  });

  it("PROBE #96: toggling the AI feature OFF tears down llmManager + webSearch", () => {
    // Pre-fix: the teardown branch only covered `!pubkey` — flag-off with a
    // logged-in user left decrypted API keys in module memory and let in-flight
    // probes keep dispatching.
    const { store } = renderWithProviders(<AIProvider />);
    act(() => {
      store.dispatch(login({ pubkey: "me", signerType: "nip07" }));
      store.dispatch(setFeatureEnabled({ feature: FEATURE_AI, enabled: true }));
    });
    vi.mocked(resetLLMManager).mockClear();
    vi.mocked(resetWebSearch).mockClear();

    act(() => {
      store.dispatch(setFeatureEnabled({ feature: FEATURE_AI, enabled: false }));
    });
    expect(resetLLMManager).toHaveBeenCalled();
    expect(resetWebSearch).toHaveBeenCalled();
    expect(abortAllTurns).toHaveBeenCalled();
  });

  it("still tears down on logout", () => {
    const { store } = renderWithProviders(<AIProvider />);
    act(() => {
      store.dispatch(login({ pubkey: "me", signerType: "nip07" }));
      store.dispatch(setFeatureEnabled({ feature: FEATURE_AI, enabled: true }));
    });
    vi.mocked(resetLLMManager).mockClear();
    act(() => {
      store.dispatch({ type: "store/RESET_ALL" });
    });
    expect(resetLLMManager).toHaveBeenCalled();
  });

  it("brings the built-in engine up only after the account's providers have loaded", async () => {
    let finishLoad = () => {};
    vi.mocked(loadProvidersForAccount).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishLoad = resolve)),
    );
    const { store } = renderWithProviders(<AIProvider />);
    vi.mocked(teardownManagedEngine).mockClear(); // the logged-out mount quiesces once
    act(() => {
      store.dispatch(login({ pubkey: "me", signerType: "nip07" }));
      store.dispatch(setFeatureEnabled({ feature: FEATURE_AI, enabled: true }));
    });
    // Registering it earlier would be wiped by the provider load's own reset.
    expect(initManagedEngine).not.toHaveBeenCalled();
    await act(async () => {
      finishLoad();
    });
    expect(initManagedEngine).toHaveBeenCalledTimes(1);
    expect(teardownManagedEngine).not.toHaveBeenCalled();
  });

  it("stops the built-in engine when the feature is turned off or the user logs out", () => {
    const { store } = renderWithProviders(<AIProvider />);
    act(() => {
      store.dispatch(login({ pubkey: "me", signerType: "nip07" }));
      store.dispatch(setFeatureEnabled({ feature: FEATURE_AI, enabled: true }));
    });
    vi.mocked(teardownManagedEngine).mockClear();
    act(() => {
      store.dispatch(setFeatureEnabled({ feature: FEATURE_AI, enabled: false }));
    });
    expect(teardownManagedEngine).toHaveBeenCalledTimes(1);

    act(() => {
      store.dispatch(setFeatureEnabled({ feature: FEATURE_AI, enabled: true }));
    });
    vi.mocked(teardownManagedEngine).mockClear();
    act(() => {
      store.dispatch({ type: "store/RESET_ALL" });
    });
    expect(teardownManagedEngine).toHaveBeenCalled();
  });
});
