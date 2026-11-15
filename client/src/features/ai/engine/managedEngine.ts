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
 * The engine's per-launch access key passes through here exactly once, from the
 * IPC reply straight into `llmManager.setManagedCredentials`. It is never held
 * in a module variable here and never dispatched.
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
import { saveAIPrefs } from "../aiPrefs";
import type { ChatChunk, ChatOptions, EngineChatMessage, LLMProvider } from "./types";
import {
  getManagedTransport,
  registerManagedProvider,
  setManagedCredentials,
  unregisterManagedProvider,
} from "./llmManager";
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
  port: number | null;
  restarts: number;
  error: unknown;
  engine_installed: boolean;
  engine_build: string;
}

function mapStatus(raw: RawStatus): ManagedEngineStatus {
  return {
    phase: raw.phase,
    modelId: raw.model_id ?? null,
    port: raw.port ?? null,
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

interface RawConnection {
  base_url: string;
  api_key: string;
  model_id: string;
}

type RawDownloadEvent =
  | { event: "progress"; downloaded: number; total: number }
  | { event: "verifying" }
  | { event: "done" };

// --- Session ------------------------------------------------------------------

/** Bumped by init and teardown; async continuations bail when superseded. */
let session = 0;
let unlisten: (() => void) | null = null;
let startInFlight: Promise<void> | null = null;

function managed() {
  return store.getState().ai.managed;
}

/**
 * Load hardware, catalogue and engine status, and follow status changes.
 * Called when the AI feature is on and an account is active (desktop only).
 */
export async function initManagedEngine(): Promise<void> {
  if (!isManagedEngineAvailable()) return;
  const mine = ++session;
  detach();
  try {
    const hardware = mapHardware(await ipc<RawHardware>("llm_hardware_info"));
    if (mine !== session) return;
    store.dispatch(setManagedHardware(hardware));

    const { listen } = await import("@tauri-apps/api/event");
    const stop = await listen<RawStatus>(STATUS_EVENT, (event) => {
      if (mine === session) void applyStatus(event.payload, mine);
    });
    if (mine !== session) {
      stop();
      return;
    }
    unlisten = stop;

    await refreshManagedModels();
    if (mine !== session) return;
    await applyStatus(await ipc<RawStatus>("llm_server_status"), mine);
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
 * Logout, or the AI feature turning off: forget the engine's key, hide the
 * tier and stop the process (a disabled feature runs nothing).
 */
export function teardownManagedEngine(): void {
  if (!isManagedEngineAvailable()) return;
  session++;
  detach();
  startInFlight = null;
  unregisterManagedProvider();
  store.dispatch(resetManagedEngine());
  void ipc("llm_server_stop").catch(() => {});
}

/** Bumped per status applied, so a slow credential fetch for an older status
 *  can never overwrite a newer one (e.g. "running" landing after "stopped"). */
let statusSeq = 0;

/**
 * Apply one status report. Credentials are settled BEFORE the status becomes
 * visible, so anything that sees `running` in the store can already reach the
 * engine, and anything that sees another phase finds no key.
 */
async function applyStatus(raw: RawStatus, mine: number): Promise<void> {
  const seq = ++statusSeq;
  const status = mapStatus(raw);
  await syncCredentials(status, mine, seq);
  if (mine !== session || seq !== statusSeq) return;
  store.dispatch(setManagedStatus(status));
  syncProvider();
}

/** Running → fetch the address + key into `llmManager`; anything else → drop them. */
async function syncCredentials(
  status: ManagedEngineStatus,
  mine: number,
  seq: number,
): Promise<void> {
  if (status.phase !== "running") {
    setManagedCredentials(null);
    return;
  }
  let connection: RawConnection | null = null;
  try {
    connection = await ipc<RawConnection | null>("llm_server_connection");
  } catch {
    connection = null;
  }
  if (mine !== session || seq !== statusSeq) return;
  setManagedCredentials(
    connection ? { baseUrl: connection.base_url, apiKey: connection.api_key } : null,
  );
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
      baseUrl: status.port ? `http://127.0.0.1:${status.port}/v1` : "http://127.0.0.1/v1",
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
    await applyStatus(await ipc<RawStatus>("llm_server_status"), mine);
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
    await applyStatus(raw, mine);
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

function startOnce(modelId: string): Promise<void> {
  if (!startInFlight) {
    const run = startCore(modelId).finally(() => {
      if (startInFlight === run) startInFlight = null;
    });
    startInFlight = run;
  }
  return startInFlight;
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
    await applyStatus(await ipc<RawStatus>("llm_server_stop"), mine);
  } catch (e) {
    store.dispatch(setManagedError({ id: ENGINE_TARGET, error: toManagedError(e) }));
  }
}

/** Resolve once the engine reports `running` (it is starting or auto-restarting). */
function waitUntilRunning(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const phase = managed().status?.phase;
      if (phase === "running") return finish(resolve);
      if (phase === "failed" || phase === "stopped" || phase === "stopping" || !phase) {
        return finish(() =>
          reject(
            managed().status?.error ?? {
              code: "startup_failed",
              message: "The built-in engine stopped before it was ready.",
            },
          ),
        );
      }
    };
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject({ code: "cancelled", message: "Cancelled." }));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject({ code: "startup_failed", message: "The built-in engine took too long to start." }),
        ),
      START_WAIT_MS,
    );
    const unsubscribe = store.subscribe(check);
    signal?.addEventListener("abort", onAbort);
    check();
  });
}

/**
 * Make sure the engine is running `modelId` and return the OpenAI-compatible
 * client for it. Starts the engine when stopped, switches when another model is
 * loaded, and waits out a start or an automatic restart already in progress.
 */
export async function ensureManagedRunning(
  modelId: string,
  signal?: AbortSignal,
): Promise<LLMProvider> {
  const status = managed().status;
  if (status?.phase === "starting" || status?.phase === "restarting") {
    await waitUntilRunning(signal);
  }
  const now = managed().status;
  if (!(now?.phase === "running" && now.modelId === modelId && getManagedTransport())) {
    await startOnce(modelId);
  }
  const transport = getManagedTransport();
  if (!transport) {
    throw {
      code: "startup_failed",
      message: "The built-in engine is not running.",
    } satisfies ManagedEngineError;
  }
  return transport;
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
    let transport: LLMProvider;
    try {
      transport = await ensureManagedRunning(opts.model, opts.signal);
    } catch (e) {
      yield { type: "error", message: describeFailure(e) };
      return;
    }
    yield* transport.chat(messages, opts);
  },

  async listModels(): Promise<AIModelInfo[]> {
    return managed()
      .models.filter((m) => m.installed)
      .map((m) => ({ id: m.id, label: m.name }));
  },

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    const transport = getManagedTransport();
    if (!transport) return { ok: false, error: "The built-in engine is not running." };
    return transport.testConnection();
  },
};
