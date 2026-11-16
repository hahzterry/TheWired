/**
 * Tier 2 of the engine stack: the built-in engine (a `llama-server` the desktop
 * app downloads, starts and supervises — see `src-tauri/src/llm.rs`).
 *
 * This module is the only caller of the `llm_*` IPC commands. It mirrors what
 * the native side reports into `aiSlice.managed` (non-secret display state) and
 * registers the engine with `llmManager` as an ordinary provider, so chat, tool
 * calls and the model picker go through the same OpenAI-compatible adapter and
 * `ChatChunk` stream as every other tier.
 *
 * The webview never connects to the engine. Requests go over IPC
 * (`llm_request`) and the native side makes the HTTP call, so the engine's
 * per-launch key and its port never reach this side at all — not this module,
 * not `llmManager`, not Redux — and no loopback HTTP permission is involved,
 * in dev or in a packaged build.
 *
 * Web builds have no native side: `isManagedEngineAvailable()` is false, nothing
 * is invoked and the tier stays hidden.
 */
import { store } from "@/store";
import {
  resetManagedEngine,
  setManagedDownload,
  setManagedError,
  setManagedHardware,
  setManagedModels,
  setManagedStatus,
  setPrefs,
} from "@/store/slices/aiSlice";
import type {
  AIModelInfo,
  ManagedEngineError,
  ManagedEngineStatus,
  ManagedErrorCode,
  ManagedHardware,
  ManagedModel,
} from "@/types/ai";
import { nanoid } from "nanoid";
import { saveAIPrefs } from "../aiPrefs";
import type { ChatChunk, ChatOptions, EngineChatMessage, LLMProvider } from "./types";
import { registerManagedProvider, unregisterManagedProvider } from "./llmManager";
import { makeOpenAICompatProvider } from "./providers/openaiCompat";
import { MANAGED_PROVIDER_ID } from "./tiers";

/** Download id of the engine runtime itself (models use their catalogue id). */
export const ENGINE_TARGET = "engine";
export const MANAGED_PROVIDER_LABEL = "Built-in engine";

const STATUS_EVENT = "llm-engine-status";
const START_WAIT_MS = 200_000;

export function isManagedEngineAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// --- IPC ----------------------------------------------------------------------

async function ipc<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

const ERROR_CODES: readonly ManagedErrorCode[] = [
  "unsupported_platform",
  "insufficient_memory",
  "insufficient_disk",
  "hash_mismatch",
  "engine_invalid",
  "network",
  "cancelled",
  "not_installed",
  "unknown_model",
  "busy",
  "startup_failed",
  "port_unavailable",
  "crashed",
  "not_running",
  "model_mismatch",
  "not_allowed",
  "unexpected_response",
  "io",
];

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Normalize whatever an IPC call rejected with into a typed error. */
export function toManagedError(e: unknown): ManagedEngineError {
  if (e && typeof e === "object") {
    const raw = e as Record<string, unknown>;
    const code = ERROR_CODES.find((c) => c === raw.code);
    if (code && typeof raw.message === "string") {
      return {
        code,
        message: raw.message,
        neededBytes: num(raw.needed_bytes),
        availableBytes: num(raw.available_bytes),
      };
    }
    if (e instanceof Error) return { code: "io", message: e.message };
  }
  return { code: "io", message: typeof e === "string" ? e : "Something went wrong." };
}

// The native side sends snake_case. Mapping field by field (instead of
// spreading) also means nothing unexpected can ride along into Redux.

interface RawStatus {
  phase: ManagedEngineStatus["phase"];
  model_id: string | null;
  restarts: number;
  error: unknown;
  engine_installed: boolean;
  engine_build: string;
}

function mapStatus(raw: RawStatus): ManagedEngineStatus {
  return {
    phase: raw.phase,
    modelId: raw.model_id ?? null,
    restarts: raw.restarts ?? 0,
    error: raw.error ? toManagedError(raw.error) : null,
    engineInstalled: !!raw.engine_installed,
    engineBuild: raw.engine_build,
  };
}

interface RawHardware {
  os: string;
  arch: string;
  total_ram_bytes: number;
  cpu_cores: number;
  free_disk_bytes: number | null;
  acceleration: "metal" | "cpu";
  engine_supported: boolean;
  engine_build: string;
  engine_download_bytes: number | null;
}

function mapHardware(raw: RawHardware): ManagedHardware {
  return {
    os: raw.os,
    arch: raw.arch,
    totalRamBytes: raw.total_ram_bytes,
    cpuCores: raw.cpu_cores,
    freeDiskBytes: raw.free_disk_bytes ?? null,
    acceleration: raw.acceleration,
    engineSupported: !!raw.engine_supported,
    engineBuild: raw.engine_build,
    engineDownloadBytes: raw.engine_download_bytes ?? null,
  };
}

interface RawModel {
  id: string;
  name: string;
  description: string;
  source: string;
  license: string;
  size_bytes: number;
  min_ram_bytes: number;
  recommended_ram_bytes: number;
  reasoning: boolean;
  installed: boolean;
  partial_bytes: number;
}

function mapModel(raw: RawModel): ManagedModel {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    source: raw.source,
    license: raw.license,
    sizeBytes: raw.size_bytes,
    minRamBytes: raw.min_ram_bytes,
    recommendedRamBytes: raw.recommended_ram_bytes,
    reasoning: !!raw.reasoning,
    installed: !!raw.installed,
    partialBytes: raw.partial_bytes ?? 0,
  };
}

type RawProxyEvent =
  | { event: "head"; status: number }
  | { event: "chunk"; text: string }
  | { event: "end" };

type RawDownloadEvent =
  | { event: "progress"; downloaded: number; total: number }
  | { event: "verifying" }
  | { event: "done" };

// --- Transport: the engine over IPC ---------------------------------------------

/**
 * Placeholder origin for the adapter's URLs. Nothing is ever fetched from it:
 * only the path is used, and the native side decides where the request goes.
 */
const ENGINE_BASE_URL = "http://built-in-engine.invalid/v1";

function abortError(): Error {
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * `fetch` for the built-in engine: the same shape the adapter gets from the
 * HTTP transport (status, streamed body), carried over IPC. The native side
 * adds the address and the key; this side never has either.
 */
async function ipcEngineFetch(url: string, init?: RequestInit): Promise<Response> {
  const signal = init?.signal ?? undefined;
  if (signal?.aborted) throw abortError();
  const { invoke, Channel } = await import("@tauri-apps/api/core");

  const body = typeof init?.body === "string" ? init.body : null;
  // The model this chat expects. The native side refuses the request if a
  // different one is loaded, so an answer can never carry the wrong label.
  let modelId: string | null = null;
  if (body) {
    try {
      const model = (JSON.parse(body) as { model?: unknown }).model;
      if (typeof model === "string") modelId = model;
    } catch {
      /* not JSON: the engine will reject it */
    }
  }

  const requestId = nanoid();
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  let finished = false;
  let resolveHead!: (status: number) => void;
  let rejectHead!: (error: Error) => void;
  const head = new Promise<number>((resolve, reject) => {
    resolveHead = resolve;
    rejectHead = reject;
  });

  const channel = new Channel<RawProxyEvent>();
  channel.onmessage = (event) => {
    if (finished) return;
    if (event.event === "head") resolveHead(event.status);
    else if (event.event === "chunk") controller.enqueue(encoder.encode(event.text));
    else {
      finished = true;
      controller.close();
    }
  };

  const onAbort = () => {
    void invoke("llm_request_cancel", { requestId }).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  void invoke<void>("llm_request", {
    requestId,
    method: (init?.method ?? "GET").toUpperCase(),
    path: new URL(url).pathname,
    body,
    modelId,
    onEvent: channel,
  })
    .catch((e: unknown) => {
      const error = signal?.aborted ? abortError() : new Error(toManagedError(e).message);
      rejectHead(error);
      if (!finished) {
        finished = true;
        controller.error(error);
      }
    })
    .finally(() => signal?.removeEventListener("abort", onAbort));

  const status = await head;
  const readText = async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    body: stream,
    text: readText,
    json: async () => JSON.parse(await readText()) as unknown,
  } as unknown as Response;
}

/** The OpenAI-compatible client for the engine, carried over IPC. No key. */
function buildTransport(): LLMProvider {
  return makeOpenAICompatProvider(
    {
      id: MANAGED_PROVIDER_ID,
      kind: "local-llama",
      label: MANAGED_PROVIDER_LABEL,
      baseUrl: ENGINE_BASE_URL,
      keyRequired: false,
    },
    () => null,
    ipcEngineFetch,
  );
}

// --- Session ------------------------------------------------------------------

/** Bumped by init and teardown; async continuations bail when superseded. */
let session = 0;
let unlisten: (() => void) | null = null;
/** True once this page has brought the engine module up. Until then nothing
 *  here has run, so there is nothing to tear down and no IPC to make. */
let engaged = false;
let startInFlight: { modelId: string; promise: Promise<void> } | null = null;
/** Exists exactly while the engine reports `running`. */
let transport: LLMProvider | null = null;

function managed() {
  return store.getState().ai.managed;
}

/** The engine's client, or null when it is not running. */
export function getManagedTransport(): LLMProvider | null {
  return transport;
}

/**
 * Load hardware, catalogue and engine status, and follow status changes.
 * Called when the AI feature is on and an account is active (desktop only).
 */
export async function initManagedEngine(): Promise<void> {
  if (!isManagedEngineAvailable()) return;
  engaged = true;
  const mine = ++session;
  detach();
  try {
    const hardware = mapHardware(await ipc<RawHardware>("llm_hardware_info"));
    if (mine !== session) return;
    store.dispatch(setManagedHardware(hardware));

    const { listen } = await import("@tauri-apps/api/event");
    const stop = await listen<RawStatus>(STATUS_EVENT, (event) => {
      if (mine === session) applyStatus(event.payload);
    });
    if (mine !== session) {
      stop();
      return;
    }
    unlisten = stop;

    await refreshManagedModels();
    if (mine !== session) return;
    const status = await ipc<RawStatus>("llm_server_status");
    if (mine !== session) return;
    applyStatus(status);
  } catch (e) {
    if (mine === session) {
      store.dispatch(setManagedError({ id: ENGINE_TARGET, error: toManagedError(e) }));
    }
  }
}

function detach(): void {
  unlisten?.();
  unlisten = null;
}

/**
 * Logout, or the AI feature turning off: hide the tier and stop the process (a
 * disabled feature runs nothing).
 *
 * A no-op unless this page actually brought the engine module up. Someone who
 * has the AI feature off, or has never logged in with it on, makes no IPC call
 * and runs none of this.
 */
export function teardownManagedEngine(): void {
  if (!engaged) return;
  engaged = false;
  session++;
  detach();
  startInFlight = null;
  transport = null;
  unregisterManagedProvider();
  store.dispatch(resetManagedEngine());
  void ipc("llm_server_stop").catch(() => {});
}

/**
 * Apply one status report. The transport is settled BEFORE the status becomes
 * visible, so anything that sees `running` in the store can already use the
 * engine, and anything that sees another phase finds none.
 */
function applyStatus(raw: RawStatus): void {
  const status = mapStatus(raw);
  transport = status.phase === "running" ? (transport ?? buildTransport()) : null;
  store.dispatch(setManagedStatus(status));
  syncProvider();
}

/** The model a new chat on the built-in engine uses: last started, else loaded, else smallest. */
function preferredModelId(installed: ManagedModel[]): string | undefined {
  const { prefs } = store.getState().ai;
  const status = managed().status;
  const has = (id: string | null | undefined) => !!id && installed.some((m) => m.id === id);
  if (has(prefs.managedModelId)) return prefs.managedModelId;
  if (has(status?.modelId)) return status?.modelId ?? undefined;
  return installed[0]?.id;
}

/**
 * The engine is offered as a provider once it could actually answer: supported
 * platform, runtime installed, at least one verified model. It need not be
 * running — the facade below starts it on first use.
 */
function syncProvider(): void {
  const { hardware, status, models } = managed();
  const installed = models.filter((m) => m.installed);
  if (!hardware?.engineSupported || !status?.engineInstalled || installed.length === 0) {
    unregisterManagedProvider();
    return;
  }
  const infos: AIModelInfo[] = installed.map((m) => ({ id: m.id, label: m.name }));
  registerManagedProvider(
    managedProvider,
    {
      label: MANAGED_PROVIDER_LABEL,
      baseUrl: ENGINE_BASE_URL,
      defaultModel: preferredModelId(installed),
    },
    infos,
    status.phase === "running",
  );
}

export async function refreshManagedModels(): Promise<void> {
  if (!isManagedEngineAvailable()) return;
  const mine = session;
  const models = (await ipc<RawModel[]>("llm_models_list")).map(mapModel);
  if (mine !== session) return;
  store.dispatch(setManagedModels(models));
  syncProvider();
}

async function refreshHardware(): Promise<void> {
  const mine = session;
  try {
    const hardware = mapHardware(await ipc<RawHardware>("llm_hardware_info"));
    if (mine === session) store.dispatch(setManagedHardware(hardware));
  } catch {
    /* keep the last reading */
  }
}

async function refreshStatus(): Promise<void> {
  const mine = session;
  try {
    const status = await ipc<RawStatus>("llm_server_status");
    if (mine === session) applyStatus(status);
  } catch {
    /* keep the last status */
  }
}

// --- Downloads ----------------------------------------------------------------

/** Run one download command, mirroring its progress and outcome into the slice. */
async function runDownload(
  id: string,
  command: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  store.dispatch(setManagedError({ id, error: null }));
  const known = managed().models.find((m) => m.id === id);
  store.dispatch(
    setManagedDownload({
      id,
      download: {
        phase: "downloading",
        downloaded: known?.partialBytes ?? 0,
        total: known?.sizeBytes ?? managed().hardware?.engineDownloadBytes ?? 0,
      },
    }),
  );
  try {
    const { Channel } = await import("@tauri-apps/api/core");
    const channel = new Channel<RawDownloadEvent>();
    channel.onmessage = (event) => {
      const current = managed().downloads[id];
      if (!current) return; // finished or cancelled; ignore stragglers
      if (event.event === "progress") {
        store.dispatch(
          setManagedDownload({
            id,
            download: { phase: "downloading", downloaded: event.downloaded, total: event.total },
          }),
        );
      } else if (event.event === "verifying") {
        store.dispatch(
          setManagedDownload({
            id,
            download: { phase: "verifying", downloaded: current.total, total: current.total },
          }),
        );
      }
    };
    await ipc<void>(command, { ...args, onEvent: channel });
    return true;
  } catch (e) {
    const error = toManagedError(e);
    // Cancelling is the user's own action, not a failure to report.
    if (error.code !== "cancelled") store.dispatch(setManagedError({ id, error }));
    return false;
  } finally {
    store.dispatch(setManagedDownload({ id, download: null }));
  }
}

/** Download the engine runtime (pinned build, verified natively). */
export async function installManagedRuntime(): Promise<boolean> {
  if (!isManagedEngineAvailable()) return false;
  if (managed().status?.engineInstalled) return true;
  if (managed().downloads[ENGINE_TARGET]) return false;
  const ok = await runDownload(ENGINE_TARGET, "llm_engine_ensure", {});
  await Promise.all([refreshStatus(), refreshHardware()]);
  return ok;
}

/** Download (or resume) a catalogue model; fetches the runtime first if needed. */
export async function downloadManagedModel(modelId: string): Promise<boolean> {
  if (!isManagedEngineAvailable()) return false;
  if (managed().downloads[modelId]) return false;
  if (!managed().status?.engineInstalled && !(await installManagedRuntime())) return false;
  const ok = await runDownload(modelId, "llm_model_download", { modelId });
  if (ok) {
    // "Removed, download it again" (or "not downloaded") has just been acted
    // on: do not leave that message standing next to a verified model.
    const stale = managed().errors[ENGINE_TARGET]?.code;
    if (stale === "hash_mismatch" || stale === "not_installed") {
      store.dispatch(setManagedError({ id: ENGINE_TARGET, error: null }));
    }
  }
  await Promise.all([refreshManagedModels().catch(() => {}), refreshHardware()]);
  return ok;
}

/** Cancel a download. The partial file is kept, so the next download resumes. */
export async function cancelManagedDownload(id: string): Promise<void> {
  if (!isManagedEngineAvailable()) return;
  await ipc("llm_download_cancel", { id }).catch(() => {});
}

export async function deleteManagedModel(modelId: string): Promise<void> {
  if (!isManagedEngineAvailable()) return;
  store.dispatch(setManagedError({ id: modelId, error: null }));
  try {
    await ipc("llm_model_delete", { modelId });
  } catch (e) {
    store.dispatch(setManagedError({ id: modelId, error: toManagedError(e) }));
  }
  await Promise.all([refreshManagedModels().catch(() => {}), refreshHardware()]);
}

export function dismissManagedError(id: string): void {
  store.dispatch(setManagedError({ id, error: null }));
}

// --- Start / stop ---------------------------------------------------------------

function rememberModel(modelId: string): void {
  const prefs = store.getState().ai.prefs;
  if (prefs.managedModelId === modelId) return;
  const next = { ...prefs, managedModelId: modelId };
  store.dispatch(setPrefs(next));
  saveAIPrefs(next);
}

/** Start (or switch to) a model. Rejects with a `ManagedEngineError`. */
async function startCore(modelId: string): Promise<void> {
  const mine = session;
  store.dispatch(setManagedError({ id: ENGINE_TARGET, error: null }));
  try {
    const raw = await ipc<RawStatus>("llm_server_start", { modelId });
    if (mine !== session) return;
    rememberModel(modelId);
    applyStatus(raw);
  } catch (e) {
    const error = toManagedError(e);
    if (mine === session) {
      if (error.code !== "cancelled") {
        store.dispatch(setManagedError({ id: ENGINE_TARGET, error }));
      }
      // A model that failed verification was removed natively: re-list.
      if (error.code === "hash_mismatch" || error.code === "not_installed") {
        await refreshManagedModels().catch(() => {});
      }
      await refreshStatus();
    }
    throw error;
  }
}

/**
 * One start at a time. A second request for the SAME model joins the first;
 * one for a DIFFERENT model waits for it to finish and then starts its own.
 * It never returns another model's start as if it were the one asked for.
 */
async function startOnce(modelId: string): Promise<void> {
  while (startInFlight && startInFlight.modelId !== modelId) {
    await startInFlight.promise.catch(() => {});
  }
  if (!startInFlight) {
    const promise = startCore(modelId).finally(() => {
      if (startInFlight?.promise === promise) startInFlight = null;
    });
    startInFlight = { modelId, promise };
  }
  return startInFlight.promise;
}

/** Settings "Start" button. Failures are shown from the slice, never thrown. */
export async function startManagedEngine(modelId: string): Promise<boolean> {
  if (!isManagedEngineAvailable()) return false;
  try {
    await startOnce(modelId);
    return true;
  } catch {
    return false;
  }
}

export async function stopManagedEngine(): Promise<void> {
  if (!isManagedEngineAvailable()) return;
  const mine = session;
  try {
    const status = await ipc<RawStatus>("llm_server_stop");
    if (mine === session) applyStatus(status);
  } catch (e) {
    store.dispatch(setManagedError({ id: ENGINE_TARGET, error: toManagedError(e) }));
  }
}

function isTransitioning(phase: string | undefined): boolean {
  return phase === "starting" || phase === "restarting" || phase === "stopping";
}

/** Resolve once the engine is no longer starting, restarting or stopping. */
function waitWhileTransitioning(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const check = () => {
      if (!isTransitioning(managed().status?.phase)) finish(resolve);
    };
    const onAbort = () =>
      finish(() => reject({ code: "cancelled", message: "Cancelled." } satisfies ManagedEngineError));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject({
            code: "startup_failed",
            message: "The built-in engine took too long to start.",
          } satisfies ManagedEngineError),
        ),
      START_WAIT_MS,
    );
    const unsubscribe = store.subscribe(check);
    signal?.addEventListener("abort", onAbort);
    check();
  });
}

function runningModel(): string | null {
  const status = managed().status;
  return status?.phase === "running" && transport ? status.modelId : null;
}

/**
 * Make sure the engine is running `modelId` and return its client.
 *
 * Starts the engine when stopped, switches when another model is loaded, and
 * waits out a start or an automatic restart already in progress. Whatever it
 * waited for, it checks WHICH model ended up loaded before returning: a start
 * that was in flight for another model is never mistaken for this one. (The
 * native side makes the same check on every request, as the backstop.)
 */
export async function ensureManagedRunning(
  modelId: string,
  signal?: AbortSignal,
): Promise<LLMProvider> {
  // Bounded: two chats asking for different models could otherwise keep
  // switching the engine out from under each other.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (runningModel() === modelId && transport) return transport;

    if (startInFlight) {
      const joined = startInFlight;
      // Our own model: its outcome is ours. Another model: just wait it out.
      if (joined.modelId === modelId) await joined.promise;
      else await joined.promise.catch(() => {});
      continue;
    }
    if (isTransitioning(managed().status?.phase)) {
      await waitWhileTransitioning(signal);
      const after = managed().status;
      // An automatic restart that just gave up is not retried in the same
      // breath; the next message will try a fresh start.
      if (after?.phase === "failed") {
        throw (
          after.error ??
          ({
            code: "startup_failed",
            message: "The built-in engine stopped before it was ready.",
          } satisfies ManagedEngineError)
        );
      }
      continue;
    }
    await startOnce(modelId);
  }
  if (runningModel() === modelId && transport) return transport;
  throw {
    code: "model_mismatch",
    message: "The built-in engine is busy with another model. Try again in a moment.",
  } satisfies ManagedEngineError;
}

function describeFailure(e: unknown): string {
  const error = toManagedError(e);
  return `Built-in engine: ${error.message} (Settings → AI)`;
}

/**
 * The provider `llmManager` hands to the chat path. It only decides WHEN to
 * talk: the actual request, SSE parsing, tool-call assembly and `ChatChunk`
 * normalization are the shared OpenAI-compatible adapter's.
 */
export const managedProvider: LLMProvider = {
  id: MANAGED_PROVIDER_ID,
  kind: "local-llama",

  async *chat(messages: EngineChatMessage[], opts: ChatOptions): AsyncIterable<ChatChunk> {
    let client: LLMProvider;
    try {
      client = await ensureManagedRunning(opts.model, opts.signal);
    } catch (e) {
      yield { type: "error", message: describeFailure(e) };
      return;
    }
    yield* client.chat(messages, opts);
  },

  async listModels(): Promise<AIModelInfo[]> {
    return managed()
      .models.filter((m) => m.installed)
      .map((m) => ({ id: m.id, label: m.name }));
  },

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    if (!transport) return { ok: false, error: "The built-in engine is not running." };
    return transport.testConnection();
  },
};
