import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ChatChunk } from "../engine/types";

// A fake native side: `invoke` is routed to `backend`, status events are pushed
// through the captured `listen` callback, and engine requests (`llm_request`)
// answer with a scripted SSE body over the IPC channel. The webview's own HTTP
// client is mocked only to prove it is never used for the built-in engine.
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as ((event: { payload: unknown }) => void)[],
  unlisten: vi.fn(),
  setSecret: vi.fn(async (_key: string, _value: string) => {}),
  fetches: [] as { url: string; init: RequestInit }[],
  sse: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => h.invoke(command, args),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, callback: (event: { payload: unknown }) => void) => {
    h.listeners.push(callback);
    return h.unlisten;
  },
}));
vi.mock("@/lib/nostr/secretStore", () => ({
  getSecret: async () => null,
  setSecret: (key: string, value: string) => h.setSecret(key, value),
  deleteSecret: vi.fn(async () => {}),
  llmProvidersKey: (pk: string) => `llm_providers_${pk}`,
  llmApiKeySecret: (pk: string, id: string) => `llm_apikey_${pk}_${id}`,
  webSearchKeySecret: (pk: string) => `ai_websearch_key_${pk}`,
}));
vi.mock("../engine/detectLocal", () => ({ detectLocalEngines: async () => [] }));
vi.mock("../engine/httpFetch", () => ({
  engineFetch: async (url: string, init: RequestInit) => {
    h.fetches.push({ url, init });
    return { ok: true, status: 200, statusText: "OK", body: null, text: async () => "", json: async () => ({ data: [] }) } as unknown as Response;
  },
  engineFetchWithTimeout: async () => ({ ok: false }) as unknown as Response,
}));

import { store } from "@/store";
import { resetManagedEngine, setPrefs } from "@/store/slices/aiSlice";
import { DEFAULT_AI_PREFS } from "../aiPrefs";
import {
  getDefaultProviderAndModel,
  getProvider,
  loadProvidersForAccount,
  providerNeedsKey,
  removeProvider,
  resetLLMManager,
  upsertProvider,
} from "../engine/llmManager";
import { MANAGED_PROVIDER_ID } from "../engine/tiers";
import {
  ENGINE_TARGET,
  cancelManagedDownload,
  deleteManagedModel,
  downloadManagedModel,
  ensureManagedRunning,
  getManagedTransport,
  initManagedEngine,
  installManagedRuntime,
  isManagedEngineAvailable,
  managedProvider,
  startManagedEngine,
  stopManagedEngine,
  teardownManagedEngine,
  toManagedError,
} from "../engine/managedEngine";

const MODEL = "qwen2.5-1.5b-instruct-q4";
const BIG = "qwen3-8b-q4";
const GIB = 1024 ** 3;

type Channel = { onmessage: ((e: unknown) => void) | null };

interface EngineRequest {
  requestId: string;
  method: string;
  path: string;
  body: string | null;
  modelId: string | null;
  /** Which model the fake engine had loaded when the request arrived. */
  loadedModel: unknown;
  argKeys: string[];
}

interface FakeBackend {
  hardware: Record<string, unknown>;
  status: Record<string, unknown>;
  models: Record<string, unknown>[];
  startError: unknown;
  /** When set, `llm_server_start` waits for it before answering. */
  startGate: Promise<void> | null;
  /** What the next download does with its progress channel. */
  download: (channel: Channel) => Promise<void>;
  /** Overrides how an engine request is answered. */
  request: ((req: EngineRequest, channel: Channel) => Promise<void>) | null;
  requests: EngineRequest[];
  cancelled: string[];
}

let backend: FakeBackend;

function rawModel(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    name: id === MODEL ? "Qwen2.5 1.5B Instruct" : "Qwen3 8B",
    description: "d",
    source: "Qwen/x",
    license: "Apache-2.0",
    size_bytes: id === MODEL ? 1_117_320_736 : 5_027_783_488,
    min_ram_bytes: (id === MODEL ? 4 : 12) * GIB,
    recommended_ram_bytes: (id === MODEL ? 8 : 16) * GIB,
    reasoning: id !== MODEL,
    installed: false,
    partial_bytes: 0,
    downloading: false,
    ...patch,
  };
}

function rawStatus(patch: Record<string, unknown> = {}) {
  return {
    phase: "stopped",
    model_id: null,
    restarts: 0,
    error: null,
    engine_installed: true,
    engine_build: "b12359",
    ...patch,
  };
}

function running(model = MODEL) {
  backend.status = rawStatus({ phase: "running", model_id: model });
}

function emitStatus(): void {
  for (const listener of h.listeners) listener({ payload: backend.status });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

function commands(): string[] {
  return h.invoke.mock.calls.map((c) => c[0] as string);
}

function starts(): unknown[] {
  return h.invoke.mock.calls.filter((c) => c[0] === "llm_server_start").map((c) => c[1].modelId);
}

function managed() {
  return store.getState().ai.managed;
}

function desktop(on: boolean): void {
  if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

/** What the real native side does with an engine request, in miniature. */
async function answerRequest(req: EngineRequest, channel: Channel): Promise<void> {
  if (backend.status.phase !== "running") throw { code: "not_running", message: "The engine is not running." };
  if (req.modelId && req.modelId !== backend.status.model_id) {
    throw {
      code: "model_mismatch",
      message: "The engine is running a different model than the one this chat uses.",
    };
  }
  channel.onmessage?.({ event: "head", status: 200 });
  if (req.path === "/v1/models") {
    channel.onmessage?.({ event: "chunk", text: JSON.stringify({ data: [{ id: backend.status.model_id }] }) });
  } else {
    for (const event of h.sse) channel.onmessage?.({ event: "chunk", text: `data: ${event}\n\n` });
  }
  channel.onmessage?.({ event: "end" });
}

beforeEach(async () => {
  desktop(true);
  backend = {
    hardware: {
      os: "macos",
      arch: "aarch64",
      total_ram_bytes: 16 * GIB,
      cpu_cores: 10,
      free_disk_bytes: 200e9,
      acceleration: "metal",
      engine_supported: true,
      engine_build: "b12359",
      engine_download_bytes: 16_907_811,
    },
    status: rawStatus(),
    models: [rawModel(MODEL, { installed: true }), rawModel(BIG)],
    startError: null,
    startGate: null,
    download: async () => {},
    request: null,
    requests: [],
    cancelled: [],
  };
  h.invoke.mockReset();
  h.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "llm_hardware_info":
        return backend.hardware;
      case "llm_models_list":
        return backend.models;
      case "llm_server_status":
        return backend.status;
      case "llm_server_start": {
        const gate = backend.startGate;
        backend.startGate = null;
        if (gate) await gate;
        if (backend.startError) throw backend.startError;
        running(args?.modelId as string);
        return backend.status;
      }
      case "llm_server_stop":
        backend.status = rawStatus();
        return backend.status;
      case "llm_model_download":
      case "llm_engine_ensure":
        await backend.download(args?.onEvent as Channel);
        return null;
      case "llm_request": {
        const req: EngineRequest = {
          requestId: args?.requestId as string,
          method: args?.method as string,
          path: args?.path as string,
          body: (args?.body as string | null) ?? null,
          modelId: (args?.modelId as string | null) ?? null,
          loadedModel: backend.status.model_id,
          argKeys: Object.keys(args ?? {}).sort(),
        };
        backend.requests.push(req);
        await (backend.request ?? answerRequest)(req, args?.onEvent as Channel);
        return null;
      }
      case "llm_request_cancel":
        backend.cancelled.push(args?.requestId as string);
        return null;
      case "llm_download_cancel":
      case "llm_model_delete":
        return null;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
  h.listeners.length = 0;
  h.unlisten.mockClear();
  h.setSecret.mockClear();
  h.fetches.length = 0;
  h.sse = [];
  resetLLMManager();
  store.dispatch(resetManagedEngine());
  store.dispatch(setPrefs(DEFAULT_AI_PREFS));
  await loadProvidersForAccount("me");
});

afterEach(async () => {
  desktop(true);
  teardownManagedEngine();
  await flush();
  desktop(false);
});

describe("web build (no native side)", () => {
  it("hides the tier: nothing is invoked and nothing is registered", async () => {
    desktop(false);
    expect(isManagedEngineAvailable()).toBe(false);
    await initManagedEngine();
    expect(await installManagedRuntime()).toBe(false);
    expect(await downloadManagedModel(MODEL)).toBe(false);
    expect(await startManagedEngine(MODEL)).toBe(false);
    await stopManagedEngine();
    await cancelManagedDownload(MODEL);
    await deleteManagedModel(MODEL);
    teardownManagedEngine();
    await flush();

    expect(h.invoke).not.toHaveBeenCalled();
    expect(managed()).toEqual({ hardware: null, status: null, models: [], downloads: {}, errors: {} });
    expect(store.getState().ai.providers[MANAGED_PROVIDER_ID]).toBeUndefined();
    expect(getProvider(MANAGED_PROVIDER_ID)).toBeUndefined();
  });
});

describe("init", () => {
  it("mirrors hardware, catalogue and status into the slice in app-side field names", async () => {
    await initManagedEngine();
    expect(managed().hardware).toMatchObject({
      totalRamBytes: 16 * GIB,
      engineSupported: true,
      acceleration: "metal",
      engineDownloadBytes: 16_907_811,
    });
    expect(managed().models.map((m) => [m.id, m.installed])).toEqual([
      [MODEL, true],
      [BIG, false],
    ]);
    expect(managed().status).toEqual({
      phase: "stopped",
      modelId: null,
      restarts: 0,
      error: null,
      engineInstalled: true,
      engineBuild: "b12359",
    });
  });

  it("offers the engine as a provider once the runtime and a verified model are present", async () => {
    await initManagedEngine();
    const config = store.getState().ai.providers[MANAGED_PROVIDER_ID];
    expect(config).toMatchObject({
      kind: "local-llama",
      label: "Built-in engine",
      keyRequired: false,
      defaultModel: MODEL,
    });
    // Stopped: listed, but not "connected" — it starts on first use.
    expect(store.getState().ai.providerStatus[MANAGED_PROVIDER_ID]).toMatchObject({
      status: "unknown",
      models: [{ id: MODEL, label: "Qwen2.5 1.5B Instruct" }],
    });
    expect(getProvider(MANAGED_PROVIDER_ID)).toBe(managedProvider);
    // The user is never asked for a key for it.
    expect(providerNeedsKey(MANAGED_PROVIDER_ID)).toBe(false);
    // With nothing else configured it is the default for a new chat.
    expect(getDefaultProviderAndModel()).toEqual({ providerId: MANAGED_PROVIDER_ID, model: MODEL });
  });

  it.each([
    ["no model is installed", () => (backend.models = [rawModel(MODEL), rawModel(BIG)])],
    ["the runtime is not installed", () => (backend.status = rawStatus({ engine_installed: false }))],
    ["the platform is unsupported", () => (backend.hardware.engine_supported = false)],
  ])("does not offer the engine while %s", async (_name, arrange) => {
    arrange();
    await initManagedEngine();
    expect(store.getState().ai.providers[MANAGED_PROVIDER_ID]).toBeUndefined();
    expect(getProvider(MANAGED_PROVIDER_ID)).toBeUndefined();
    expect(getDefaultProviderAndModel()).toBeNull();
  });

  it("reports a failing native call instead of leaving the section spinning", async () => {
    h.invoke.mockImplementationOnce(async () => {
      throw "llm_hardware_info not allowed";
    });
    await initManagedEngine();
    expect(managed().hardware).toBeNull();
    expect(managed().errors[ENGINE_TARGET]).toEqual({
      code: "io",
      message: "llm_hardware_info not allowed",
      neededBytes: undefined,
      availableBytes: undefined,
    });
  });
});

describe("security contract: the engine's key and address stay native", () => {
  it("the webview is told neither, and asks for neither", async () => {
    running();
    await initManagedEngine();
    h.sse = [JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }), "[DONE]"];
    await collect(managedProvider.chat([{ role: "user", content: "hello" }], { model: MODEL }));

    // There is no command that returns a key or an address, and none is called.
    expect(commands()).not.toContain("llm_server_connection");
    // The status mirrored into Redux has exactly these fields: no key, no port.
    expect(Object.keys(managed().status!).sort()).toEqual(
      ["engineBuild", "engineInstalled", "error", "modelId", "phase", "restarts"].sort(),
    );
    // The provider entry is not a network address and has no key-shaped field.
    const config = store.getState().ai.providers[MANAGED_PROVIDER_ID];
    expect(Object.keys(config).sort()).toEqual(
      ["baseUrl", "defaultModel", "id", "keyRequired", "kind", "label"].sort(),
    );
    expect(config.baseUrl).toBe("http://built-in-engine.invalid/v1");
    const state = JSON.stringify(store.getState());
    expect(state).not.toMatch(/api[_-]?key/i);
    expect(state).not.toContain("127.0.0.1");
  });

  it("a chat goes over IPC with no credentials, never through the webview's HTTP client", async () => {
    running();
    await initManagedEngine();
    h.sse = [JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }), "[DONE]"];
    await collect(managedProvider.chat([{ role: "user", content: "hello" }], { model: MODEL }));

    expect(h.fetches).toHaveLength(0);
    expect(backend.requests).toHaveLength(1);
    const request = backend.requests[0];
    // Exactly these arguments cross the boundary: no header bag, no URL, no key.
    expect(request.argKeys).toEqual(["body", "method", "modelId", "onEvent", "path", "requestId"]);
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v1/chat/completions");
    expect(request.modelId).toBe(MODEL);
    expect(request.body).not.toMatch(/authorization|bearer/i);
  });

  it("is never a stored provider, and nothing about it reaches the keychain", async () => {
    running();
    await initManagedEngine();
    await upsertProvider(
      { kind: "openai-compat", label: "Ollama", baseUrl: "http://localhost:11434/v1", keyRequired: false },
      undefined,
    );
    expect(h.setSecret).toHaveBeenCalled();
    for (const [name, value] of h.setSecret.mock.calls) {
      expect(name).not.toContain(MANAGED_PROVIDER_ID);
      expect(value).not.toContain(MANAGED_PROVIDER_ID);
      expect(value).not.toContain("built-in-engine");
    }
    // The user is never asked for a key for it either.
    expect(providerNeedsKey(MANAGED_PROVIDER_ID)).toBe(false);
  });

  it("stops being usable the moment the engine is not running", async () => {
    running();
    await initManagedEngine();
    expect(getManagedTransport()).not.toBeNull();

    // The process died; the native side is restarting it.
    backend.status = rawStatus({ phase: "restarting", model_id: MODEL, restarts: 1 });
    emitStatus();
    expect(getManagedTransport()).toBeNull();
    expect(managed().status).toMatchObject({ phase: "restarting", restarts: 1 });
    expect(store.getState().ai.providerStatus[MANAGED_PROVIDER_ID].status).toBe("unknown");

    running();
    emitStatus();
    expect(getManagedTransport()).not.toBeNull();
    expect(store.getState().ai.providerStatus[MANAGED_PROVIDER_ID].status).toBe("connected");
  });

  it("is not offered when no account is active", async () => {
    resetLLMManager(); // logged out
    running();
    await initManagedEngine();
    expect(store.getState().ai.providers[MANAGED_PROVIDER_ID]).toBeUndefined();
    expect(getProvider(MANAGED_PROVIDER_ID)).toBeUndefined();
  });

  it("cannot be edited or removed through the generic provider API", async () => {
    running();
    await initManagedEngine();
    await expect(
      upsertProvider({
        id: MANAGED_PROVIDER_ID,
        kind: "openai-compat",
        label: "hijack",
        baseUrl: "https://evil.example/v1",
        keyRequired: false,
      }),
    ).rejects.toThrow();
    await removeProvider(MANAGED_PROVIDER_ID);
    expect(store.getState().ai.providers[MANAGED_PROVIDER_ID].baseUrl).toBe(
      "http://built-in-engine.invalid/v1",
    );
    expect(getProvider(MANAGED_PROVIDER_ID)).toBe(managedProvider);
  });
});

describe("chat through the built-in engine", () => {
  it("yields the same ChatChunk stream as any OpenAI-compatible provider, tool calls included", async () => {
    running();
    await initManagedEngine();
    h.sse = [
      JSON.stringify({ choices: [{ delta: { content: "Let me check. " } }] }),
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_1", function: { name: "get_profile", arguments: '{"pub' } }],
            },
          },
        ],
      }),
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'key":"abc"}' } }] }, finish_reason: "tool_calls" },
        ],
      }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } }),
      "[DONE]",
    ];
    const chunks = await collect(
      managedProvider.chat([{ role: "user", content: "who is abc?" }], {
        model: MODEL,
        tools: [{ name: "get_profile", description: "d", parameters: { type: "object" } }],
      }),
    );
    expect(chunks).toEqual([
      { type: "text", delta: "Let me check. " },
      { type: "usage", promptTokens: 12, completionTokens: 7 },
      { type: "tool_call", toolCalls: [{ id: "call_1", name: "get_profile", arguments: '{"pubkey":"abc"}' }] },
      { type: "done", finishReason: "tool_calls" },
    ]);
    const body = JSON.parse(backend.requests[0].body!);
    expect(body.model).toBe(MODEL);
    expect(body.stream).toBe(true);
    expect(body.tools[0].function.name).toBe("get_profile");
  });

  it("reassembles text that arrives split across IPC messages", async () => {
    running();
    await initManagedEngine();
    const event = `data: ${JSON.stringify({ choices: [{ delta: { content: "café 日本" }, finish_reason: "stop" }] })}\n\n`;
    backend.request = async (_req, channel) => {
      channel.onmessage?.({ event: "head", status: 200 });
      // One SSE event delivered in three pieces, cut mid-line.
      channel.onmessage?.({ event: "chunk", text: event.slice(0, 20) });
      channel.onmessage?.({ event: "chunk", text: event.slice(20, 41) });
      channel.onmessage?.({ event: "chunk", text: event.slice(41) + "data: [DONE]\n\n" });
      channel.onmessage?.({ event: "end" });
    };
    const chunks = await collect(managedProvider.chat([{ role: "user", content: "x" }], { model: MODEL }));
    expect(chunks).toEqual([
      { type: "text", delta: "café 日本" },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("passes an engine error status through as one clear error", async () => {
    running();
    await initManagedEngine();
    backend.request = async (_req, channel) => {
      channel.onmessage?.({ event: "head", status: 500 });
      channel.onmessage?.({ event: "chunk", text: '{"error":{"message":"context size exceeded"}}' });
      channel.onmessage?.({ event: "end" });
    };
    const chunks = await collect(managedProvider.chat([{ role: "user", content: "x" }], { model: MODEL }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: "error" });
    expect((chunks[0] as { message: string }).message).toContain("500");
    expect((chunks[0] as { message: string }).message).toContain("context size exceeded");
  });

  it("Stop cancels the request natively and ends the stream", async () => {
    running();
    await initManagedEngine();
    let failRequest: (e: unknown) => void = () => {};
    backend.request = (_req, channel) =>
      new Promise<void>((_resolve, reject) => {
        failRequest = reject;
        channel.onmessage?.({ event: "head", status: 200 });
        channel.onmessage?.({
          event: "chunk",
          text: `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`,
        });
      });
    const controller = new AbortController();
    const seen: ChatChunk[] = [];
    const reading = (async () => {
      for await (const chunk of managedProvider.chat([{ role: "user", content: "x" }], {
        model: MODEL,
        signal: controller.signal,
      })) {
        seen.push(chunk);
        if (chunk.type === "text") {
          controller.abort();
          // The native side stops the stream when told to.
          await flush();
          failRequest({ code: "cancelled", message: "Cancelled." });
        }
      }
    })();
    await reading;

    expect(backend.cancelled).toEqual([backend.requests[0].requestId]);
    expect(seen[0]).toEqual({ type: "text", delta: "partial" });
    // Ends like any aborted provider stream: an error chunk, no "done".
    expect(seen[seen.length - 1].type).toBe("error");
    expect(seen.some((c) => c.type === "done")).toBe(false);
  });

  it("makes no request at all when the turn was already stopped", async () => {
    running();
    await initManagedEngine();
    const controller = new AbortController();
    controller.abort();
    const chunks = await collect(
      managedProvider.chat([{ role: "user", content: "x" }], { model: MODEL, signal: controller.signal }),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("error");
    expect(backend.requests).toHaveLength(0);
  });

  it("checks the connection over IPC too", async () => {
    await initManagedEngine();
    expect(await managedProvider.testConnection()).toEqual({
      ok: false,
      error: "The built-in engine is not running.",
    });
    running();
    emitStatus();
    expect(await managedProvider.testConnection()).toEqual({ ok: true });
    const last = backend.requests[backend.requests.length - 1];
    expect([last.method, last.path, last.body]).toEqual(["GET", "/v1/models", null]);
    expect(h.fetches).toHaveLength(0);
  });

  it("starts a stopped engine on first use, then chats", async () => {
    await initManagedEngine();
    expect(managed().status?.phase).toBe("stopped");
    h.sse = [JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }), "[DONE]"];
    const chunks = await collect(managedProvider.chat([{ role: "user", content: "hi" }], { model: MODEL }));

    expect(starts()).toEqual([MODEL]);
    expect(chunks).toEqual([
      { type: "text", delta: "ok" },
      { type: "done", finishReason: "stop" },
    ]);
    expect(managed().status?.phase).toBe("running");
    // The model that was started is remembered for next time.
    expect(store.getState().ai.prefs.managedModelId).toBe(MODEL);
  });

  it("switches models when the conversation asks for a different installed one", async () => {
    backend.models = [rawModel(MODEL, { installed: true }), rawModel(BIG, { installed: true })];
    running();
    await initManagedEngine();
    h.sse = ["[DONE]"];
    await collect(managedProvider.chat([{ role: "user", content: "hi" }], { model: BIG }));
    expect(starts()).toEqual([BIG]);
    expect(managed().status?.modelId).toBe(BIG);
    expect(backend.requests[0]).toMatchObject({ modelId: BIG, loadedModel: BIG });
  });

  it("does not restart an engine that is already running the requested model", async () => {
    running();
    await initManagedEngine();
    h.sse = ["[DONE]"];
    await collect(managedProvider.chat([{ role: "user", content: "hi" }], { model: MODEL }));
    expect(commands()).not.toContain("llm_server_start");
  });

  it("turns a failed start into one clear error chunk and makes no request", async () => {
    await initManagedEngine();
    backend.startError = { code: "startup_failed", message: "The engine exited while starting: bad model" };
    const chunks = await collect(managedProvider.chat([{ role: "user", content: "hi" }], { model: MODEL }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: "error" });
    expect((chunks[0] as { message: string }).message).toContain("bad model");
    expect(backend.requests).toHaveLength(0);
    expect(managed().errors[ENGINE_TARGET]?.code).toBe("startup_failed");
  });

  it("waits out a restart already in progress instead of racing it with another start", async () => {
    running();
    await initManagedEngine();
    backend.status = rawStatus({ phase: "restarting", model_id: MODEL, restarts: 1 });
    emitStatus();

    const pending = ensureManagedRunning(MODEL);
    await flush();
    expect(commands()).not.toContain("llm_server_start");
    running();
    emitStatus();
    const transport = await pending;
    expect(transport).toBe(getManagedTransport());
    expect(commands()).not.toContain("llm_server_start");
  });

  it("gives up waiting when the restart ends in failure", async () => {
    running();
    await initManagedEngine();
    backend.status = rawStatus({ phase: "restarting", model_id: MODEL, restarts: 3 });
    emitStatus();

    const pending = ensureManagedRunning(MODEL);
    backend.status = rawStatus({
      phase: "failed",
      model_id: MODEL,
      restarts: 3,
      error: { code: "crashed", message: "The engine stopped unexpectedly 4 times in a row." },
    });
    emitStatus();
    await expect(pending).rejects.toMatchObject({ code: "crashed" });
    // It does not override the supervisor's decision in the same breath.
    expect(commands()).not.toContain("llm_server_start");
  });
});

describe("two models, one engine", () => {
  beforeEach(() => {
    backend.models = [rawModel(MODEL, { installed: true }), rawModel(BIG, { installed: true })];
  });

  it("REGRESSION: a chat that joins another model's start is not answered by that model", async () => {
    // Found in review: a chat sent while a different model was starting joined
    // that start and was then answered by it, labelled with the model the user
    // had picked.
    await initManagedEngine();
    let release = () => {};
    backend.startGate = new Promise<void>((resolve) => (release = resolve));
    const settingsStart = startManagedEngine(MODEL); // e.g. the Settings button
    await flush();

    h.sse = [JSON.stringify({ choices: [{ delta: { content: "from the big one" }, finish_reason: "stop" }] }), "[DONE]"];
    const chat = collect(managedProvider.chat([{ role: "user", content: "hi" }], { model: BIG }));
    await flush();
    // It is waiting, and has NOT fired a second start into the first.
    expect(starts()).toEqual([MODEL]);
    expect(backend.requests).toHaveLength(0);

    release();
    await settingsStart;
    const chunks = await chat;

    // The first start finished with the wrong model for this chat, so the
    // engine was switched before the request was made.
    expect(starts()).toEqual([MODEL, BIG]);
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]).toMatchObject({ modelId: BIG, loadedModel: BIG });
    expect(chunks[0]).toEqual({ type: "text", delta: "from the big one" });
    expect(managed().status?.modelId).toBe(BIG);
  });

  it("two chats for the same model during one start share that start", async () => {
    await initManagedEngine();
    let release = () => {};
    backend.startGate = new Promise<void>((resolve) => (release = resolve));
    h.sse = ["[DONE]"];
    const a = collect(managedProvider.chat([{ role: "user", content: "a" }], { model: MODEL }));
    const b = collect(managedProvider.chat([{ role: "user", content: "b" }], { model: MODEL }));
    await flush();
    release();
    await Promise.all([a, b]);
    expect(starts()).toEqual([MODEL]);
    expect(backend.requests.map((r) => r.loadedModel)).toEqual([MODEL, MODEL]);
  });

  it("a failed start for another model does not fail this chat", async () => {
    await initManagedEngine();
    let fail = () => {};
    backend.startGate = new Promise<void>((_resolve, reject) => (fail = () => reject(new Error("unused"))));
    // The gate rejects → the fake treats it as a thrown start.
    const settingsStart = startManagedEngine(MODEL);
    await flush();
    h.sse = ["[DONE]"];
    const chat = collect(managedProvider.chat([{ role: "user", content: "hi" }], { model: BIG }));
    await flush();
    fail();
    expect(await settingsStart).toBe(false);
    const chunks = await chat;
    expect(starts()).toEqual([MODEL, BIG]);
    expect(chunks[chunks.length - 1]).toEqual({ type: "done", finishReason: undefined });
    expect(backend.requests[0]).toMatchObject({ modelId: BIG, loadedModel: BIG });
  });

  it("the native check is the backstop: a request for a model that is not loaded fails clearly", async () => {
    running(MODEL);
    await initManagedEngine();
    // The engine is switched behind the webview's back, with no status event.
    backend.status = rawStatus({ phase: "running", model_id: BIG });
    const chunks = await collect(managedProvider.chat([{ role: "user", content: "hi" }], { model: MODEL }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: "error" });
    expect((chunks[0] as { message: string }).message).toContain("different model");
  });

  it("gives up cleanly instead of switching back and forth forever", async () => {
    await initManagedEngine();
    // Every start "succeeds" but leaves the other model loaded.
    h.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "llm_server_start") {
        running(args?.modelId === MODEL ? BIG : MODEL);
        return backend.status;
      }
      if (command === "llm_server_status") return backend.status;
      if (command === "llm_models_list") return backend.models;
      if (command === "llm_server_stop") return rawStatus();
      throw new Error(`unexpected command ${command}`);
    });
    await expect(ensureManagedRunning(MODEL)).rejects.toMatchObject({ code: "model_mismatch" });
    expect(starts()).toHaveLength(3);
  });
});

describe("downloads", () => {
  it("mirrors progress, then verification, and clears the entry when done", async () => {
    backend.models = [rawModel(MODEL), rawModel(BIG)];
    await initManagedEngine();
    const seen: unknown[] = [];
    backend.download = async (channel) => {
      seen.push(managed().downloads[MODEL]); // registered before the first event
      channel.onmessage?.({ event: "progress", downloaded: 250, total: 1000 });
      seen.push(managed().downloads[MODEL]);
      channel.onmessage?.({ event: "verifying" });
      seen.push(managed().downloads[MODEL]);
      channel.onmessage?.({ event: "done" });
      backend.models = [rawModel(MODEL, { installed: true }), rawModel(BIG)];
    };

    expect(await downloadManagedModel(MODEL)).toBe(true);
    expect(seen).toEqual([
      { phase: "downloading", downloaded: 0, total: 1_117_320_736 },
      { phase: "downloading", downloaded: 250, total: 1000 },
      { phase: "verifying", downloaded: 1000, total: 1000 },
    ]);
    expect(managed().downloads).toEqual({});
    expect(managed().errors).toEqual({});
    // The catalogue was re-read and the engine became available as a provider.
    expect(managed().models[0].installed).toBe(true);
    expect(store.getState().ai.providers[MANAGED_PROVIDER_ID]).toBeDefined();
    expect(h.invoke).toHaveBeenCalledWith("llm_model_download", expect.objectContaining({ modelId: MODEL }));
  });

  it("starts a resumed download's bar from the bytes already on disk", async () => {
    backend.models = [rawModel(MODEL, { partial_bytes: 400_000_000 }), rawModel(BIG)];
    await initManagedEngine();
    let first: unknown;
    backend.download = async () => {
      first = managed().downloads[MODEL];
    };
    await downloadManagedModel(MODEL);
    expect(first).toEqual({ phase: "downloading", downloaded: 400_000_000, total: 1_117_320_736 });
  });

  it("treats a cancel as the user's choice, not an error", async () => {
    backend.models = [rawModel(MODEL), rawModel(BIG)];
    await initManagedEngine();
    backend.download = async () => {
      throw { code: "cancelled", message: "Download cancelled." };
    };
    expect(await downloadManagedModel(MODEL)).toBe(false);
    expect(managed().errors).toEqual({});
    expect(managed().downloads).toEqual({});

    await cancelManagedDownload(MODEL);
    expect(h.invoke).toHaveBeenCalledWith("llm_download_cancel", { id: MODEL });
  });

  it.each([
    [
      "insufficient disk",
      { code: "insufficient_disk", message: "Not enough free disk space.", needed_bytes: 1_400_000_000, available_bytes: 300_000_000 },
      { code: "insufficient_disk", neededBytes: 1_400_000_000, availableBytes: 300_000_000 },
    ],
    ["a checksum mismatch", { code: "hash_mismatch", message: "The file does not match its expected checksum." }, { code: "hash_mismatch" }],
    ["a network failure", { code: "network", message: "The download was interrupted" }, { code: "network" }],
  ])("records %s against the model", async (_name, thrown, expected) => {
    backend.models = [rawModel(MODEL), rawModel(BIG)];
    await initManagedEngine();
    backend.download = async () => {
      throw thrown;
    };
    expect(await downloadManagedModel(MODEL)).toBe(false);
    expect(managed().errors[MODEL]).toMatchObject(expected);
    expect(managed().downloads).toEqual({});
    // A retry clears the stale error first.
    backend.download = async () => {};
    await downloadManagedModel(MODEL);
    expect(managed().errors[MODEL]).toBeUndefined();
  });

  it("fetches the runtime first when it is missing, and stops if that fails", async () => {
    backend.status = rawStatus({ engine_installed: false });
    backend.models = [rawModel(MODEL), rawModel(BIG)];
    await initManagedEngine();

    backend.download = async () => {
      throw { code: "network", message: "offline" };
    };
    expect(await downloadManagedModel(MODEL)).toBe(false);
    expect(commands()).toContain("llm_engine_ensure");
    expect(commands()).not.toContain("llm_model_download");
    expect(managed().errors[ENGINE_TARGET]?.code).toBe("network");

    // Second try: the runtime installs, then the model download runs.
    backend.download = async () => {
      backend.status = rawStatus({ engine_installed: true });
    };
    expect(await downloadManagedModel(MODEL)).toBe(true);
    expect(commands().filter((c) => c === "llm_model_download")).toHaveLength(1);
    expect(managed().status?.engineInstalled).toBe(true);
    expect(managed().errors[ENGINE_TARGET]).toBeUndefined();
  });

  it("REGRESSION: re-downloading a model clears the 'removed, download it again' error", async () => {
    // Found in live QA: after a damaged model was removed and downloaded again,
    // the old verification error stayed on screen beside the verified model.
    await initManagedEngine();
    backend.startError = { code: "hash_mismatch", message: "so it was removed. Download it again." };
    backend.models = [rawModel(MODEL), rawModel(BIG)];
    await startManagedEngine(MODEL);
    expect(managed().errors[ENGINE_TARGET]?.code).toBe("hash_mismatch");

    backend.download = async () => {
      backend.models = [rawModel(MODEL, { installed: true }), rawModel(BIG)];
    };
    expect(await downloadManagedModel(MODEL)).toBe(true);
    expect(managed().errors[ENGINE_TARGET]).toBeUndefined();
  });

  it("a successful download leaves an unrelated engine error alone", async () => {
    await initManagedEngine();
    backend.startError = { code: "startup_failed", message: "nope" };
    await startManagedEngine(MODEL);
    backend.models = [rawModel(MODEL, { installed: true }), rawModel(BIG)];
    expect(await downloadManagedModel(BIG)).toBe(true);
    expect(managed().errors[ENGINE_TARGET]?.code).toBe("startup_failed");
  });

  it("ignores a second request for a download already in flight", async () => {
    backend.models = [rawModel(MODEL), rawModel(BIG)];
    await initManagedEngine();
    let release = () => {};
    backend.download = () => new Promise<void>((resolve) => (release = resolve));
    const first = downloadManagedModel(MODEL);
    await flush();
    expect(await downloadManagedModel(MODEL)).toBe(false);
    release();
    await first;
    expect(commands().filter((c) => c === "llm_model_download")).toHaveLength(1);
  });

  it("deleting re-reads the catalogue and withdraws the provider when nothing is left", async () => {
    await initManagedEngine();
    expect(store.getState().ai.providers[MANAGED_PROVIDER_ID]).toBeDefined();
    backend.models = [rawModel(MODEL), rawModel(BIG)];
    await deleteManagedModel(MODEL);
    expect(h.invoke).toHaveBeenCalledWith("llm_model_delete", { modelId: MODEL });
    expect(store.getState().ai.providers[MANAGED_PROVIDER_ID]).toBeUndefined();
  });

  it("shows why a delete was refused", async () => {
    await initManagedEngine();
    h.invoke.mockImplementationOnce(async () => {
      throw { code: "busy", message: "Stop the engine before deleting the model it is using." };
    });
    await deleteManagedModel(MODEL);
    expect(managed().errors[MODEL]).toMatchObject({ code: "busy" });
  });
});

describe("start / stop", () => {
  it("start reports success and connects the provider", async () => {
    await initManagedEngine();
    expect(await startManagedEngine(MODEL)).toBe(true);
    expect(managed().status).toMatchObject({ phase: "running", modelId: MODEL });
    expect(store.getState().ai.providerStatus[MANAGED_PROVIDER_ID].status).toBe("connected");
    expect(getManagedTransport()).not.toBeNull();
  });

  it("a model that failed verification is reported and the catalogue re-read", async () => {
    await initManagedEngine();
    backend.startError = {
      code: "hash_mismatch",
      message: "The model file was changed or damaged on disk, so it was removed. Download it again.",
    };
    backend.models = [rawModel(MODEL), rawModel(BIG)]; // natively removed
    expect(await startManagedEngine(MODEL)).toBe(false);
    expect(managed().errors[ENGINE_TARGET]).toMatchObject({ code: "hash_mismatch" });
    expect(managed().models[0].installed).toBe(false);
    // Nothing verified is left, so the engine is no longer offered.
    expect(store.getState().ai.providers[MANAGED_PROVIDER_ID]).toBeUndefined();
  });

  it.each(["startup_failed", "port_unavailable", "insufficient_memory", "unsupported_platform"])(
    "surfaces a %s start failure in the slice without throwing",
    async (code) => {
      await initManagedEngine();
      backend.startError = { code, message: "nope" };
      expect(await startManagedEngine(MODEL)).toBe(false);
      expect(managed().errors[ENGINE_TARGET]).toMatchObject({ code, message: "nope" });
      expect(getManagedTransport()).toBeNull();
    },
  );

  it("stop marks the provider not connected and drops the client", async () => {
    running();
    await initManagedEngine();
    await stopManagedEngine();
    expect(managed().status?.phase).toBe("stopped");
    expect(getManagedTransport()).toBeNull();
    expect(store.getState().ai.providerStatus[MANAGED_PROVIDER_ID].status).toBe("unknown");
  });

  it("the store never shows 'running' before the engine is actually usable", async () => {
    await initManagedEngine();
    const seen: boolean[] = [];
    const unsubscribe = store.subscribe(() => {
      if (managed().status?.phase === "running") seen.push(getManagedTransport() !== null);
    });
    running();
    emitStatus();
    unsubscribe();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });
});

describe("teardown", () => {
  it("REGRESSION: makes no native call when the engine module was never brought up", async () => {
    // Found in review: every logged-out mount and every user with the AI
    // feature off ran this and sent `llm_server_stop`.
    teardownManagedEngine();
    teardownManagedEngine();
    await flush();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("stops the process, hides the tier and ignores later events, once", async () => {
    running();
    await initManagedEngine();
    teardownManagedEngine();
    await flush();
    expect(commands().filter((c) => c === "llm_server_stop")).toHaveLength(1);
    expect(h.unlisten).toHaveBeenCalled();
    expect(managed().status).toBeNull();
    expect(getManagedTransport()).toBeNull();
    expect(store.getState().ai.providers[MANAGED_PROVIDER_ID]).toBeUndefined();

    // A straggling event from before the teardown must not bring it back.
    running();
    emitStatus();
    await flush();
    expect(managed().status).toBeNull();
    expect(getManagedTransport()).toBeNull();

    // A second teardown has nothing left to do.
    teardownManagedEngine();
    await flush();
    expect(commands().filter((c) => c === "llm_server_stop")).toHaveLength(1);
  });

  it("an engine left running by an earlier page load is picked up, not stopped", async () => {
    // The webview reloads while the engine runs: the logged-out mount tears
    // down (a no-op now), then login brings the module up and finds it running.
    running();
    teardownManagedEngine();
    await initManagedEngine();
    expect(commands()).not.toContain("llm_server_stop");
    expect(managed().status?.phase).toBe("running");
    expect(getManagedTransport()).not.toBeNull();
  });
});

describe("toManagedError", () => {
  it("keeps typed native errors and their byte counts", () => {
    expect(toManagedError({ code: "insufficient_disk", message: "m", needed_bytes: 5, available_bytes: 1 })).toEqual({
      code: "insufficient_disk",
      message: "m",
      neededBytes: 5,
      availableBytes: 1,
    });
  });

  it("maps anything unrecognised to a generic error without inventing a code", () => {
    expect(toManagedError("command llm_server_start not allowed by ACL")).toMatchObject({
      code: "io",
      message: "command llm_server_start not allowed by ACL",
    });
    expect(toManagedError({ code: "made_up", message: "m" })).toMatchObject({ code: "io" });
    expect(toManagedError(new Error("boom"))).toMatchObject({ code: "io", message: "boom" });
    expect(toManagedError(null)).toMatchObject({ code: "io" });
    expect(toManagedError(undefined).message).toBeTruthy();
  });
});
