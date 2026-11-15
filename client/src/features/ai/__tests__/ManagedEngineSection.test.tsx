import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { createTestStore } from "@/__tests__/helpers/createTestStore";
import {
  setManagedDownload,
  setManagedError,
  setManagedHardware,
  setManagedModels,
  setManagedStatus,
} from "@/store/slices/aiSlice";
import type {
  ManagedEngineError,
  ManagedEngineStatus,
  ManagedHardware,
  ManagedModel,
} from "@/types/ai";

const engine = vi.hoisted(() => ({
  available: true,
  installManagedRuntime: vi.fn(async () => true),
  downloadManagedModel: vi.fn(async (_id: string) => true),
  cancelManagedDownload: vi.fn(async (_id: string) => {}),
  deleteManagedModel: vi.fn(async (_id: string) => {}),
  startManagedEngine: vi.fn(async (_id: string) => true),
  stopManagedEngine: vi.fn(async () => {}),
  dismissManagedError: vi.fn((_id: string) => {}),
}));

vi.mock("../engine/managedEngine", () => ({
  ENGINE_TARGET: "engine",
  isManagedEngineAvailable: () => engine.available,
  installManagedRuntime: () => engine.installManagedRuntime(),
  downloadManagedModel: (id: string) => engine.downloadManagedModel(id),
  cancelManagedDownload: (id: string) => engine.cancelManagedDownload(id),
  deleteManagedModel: (id: string) => engine.deleteManagedModel(id),
  startManagedEngine: (id: string) => engine.startManagedEngine(id),
  stopManagedEngine: () => engine.stopManagedEngine(),
  dismissManagedError: (id: string) => engine.dismissManagedError(id),
}));

import { ManagedEngineSection } from "../ManagedEngineSection";

const GIB = 1024 ** 3;
const SMALL = "qwen2.5-1.5b-instruct-q4";
const LARGE = "qwen3-8b-q4";

const hardware: ManagedHardware = {
  os: "macos",
  arch: "aarch64",
  totalRamBytes: 16 * GIB,
  cpuCores: 10,
  freeDiskBytes: 212e9,
  acceleration: "metal",
  engineSupported: true,
  engineBuild: "b12359",
  engineDownloadBytes: 16_907_811,
};

function status(patch: Partial<ManagedEngineStatus> = {}): ManagedEngineStatus {
  return {
    phase: "stopped",
    modelId: null,
    port: null,
    restarts: 0,
    error: null,
    engineInstalled: true,
    engineBuild: "b12359",
    ...patch,
  };
}

function model(id: string, patch: Partial<ManagedModel> = {}): ManagedModel {
  const small = id === SMALL;
  return {
    id,
    name: small ? "Qwen2.5 1.5B Instruct" : "Qwen3 8B",
    description: small ? "Small and fast." : "Most capable.",
    source: small ? "Qwen/Qwen2.5-1.5B-Instruct-GGUF" : "Qwen/Qwen3-8B-GGUF",
    license: "Apache-2.0",
    sizeBytes: small ? 1_117_320_736 : 5_027_783_488,
    minRamBytes: (small ? 4 : 12) * GIB,
    recommendedRamBytes: (small ? 8 : 16) * GIB,
    reasoning: !small,
    installed: false,
    partialBytes: 0,
    ...patch,
  };
}

interface Scenario {
  hardware?: ManagedHardware | null;
  status?: ManagedEngineStatus | null;
  models?: ManagedModel[];
  downloads?: Record<string, { phase: "downloading" | "verifying"; downloaded: number; total: number }>;
  errors?: Record<string, ManagedEngineError>;
}

function renderSection(scenario: Scenario = {}) {
  const store = createTestStore();
  const hw = scenario.hardware === undefined ? hardware : scenario.hardware;
  if (hw) store.dispatch(setManagedHardware(hw));
  const st = scenario.status === undefined ? status() : scenario.status;
  if (st) store.dispatch(setManagedStatus(st));
  store.dispatch(setManagedModels(scenario.models ?? [model(SMALL), model(LARGE)]));
  for (const [id, download] of Object.entries(scenario.downloads ?? {})) {
    store.dispatch(setManagedDownload({ id, download }));
  }
  for (const [id, error] of Object.entries(scenario.errors ?? {})) {
    store.dispatch(setManagedError({ id, error }));
  }
  return renderWithProviders(<ManagedEngineSection />, { store });
}

function row(name: string): HTMLElement {
  const item = screen.getByText(name).closest("li");
  if (!item) throw new Error(`no row for ${name}`);
  return item;
}

beforeEach(() => {
  engine.available = true;
  for (const fn of Object.values(engine)) {
    if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
  }
});

describe("ManagedEngineSection — availability", () => {
  it("renders nothing on the web build, even with state present", () => {
    engine.available = false;
    const { container } = renderSection({ status: status({ phase: "running", modelId: SMALL, port: 5 }) });
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Built-in engine")).toBeNull();
  });

  it("shows a checking state until the machine has been probed", () => {
    renderSection({ hardware: null, status: null, models: [] });
    expect(screen.getByText("Built-in engine")).toBeInTheDocument();
    expect(screen.getByText(/Checking this machine/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download/ })).toBeNull();
  });

  it("explains an unsupported system and offers no downloads", () => {
    renderSection({
      hardware: { ...hardware, os: "windows", arch: "x86_64", acceleration: "cpu", engineSupported: false },
    });
    expect(screen.getByText("Not available on this system yet")).toBeInTheDocument();
    expect(screen.getByText(/Ollama or LM Studio/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Qwen2.5 1.5B Instruct")).toBeNull();
  });

  it("summarises the machine: acceleration, memory and free disk", () => {
    renderSection();
    expect(screen.getByText(/Apple Silicon \(GPU accelerated\) · 16 GB memory · 212 GB free disk/)).toBeInTheDocument();
  });
});

describe("ManagedEngineSection — runtime", () => {
  it("offers the runtime download with its size when it is not installed", () => {
    renderSection({ status: status({ engineInstalled: false }) });
    expect(screen.getByText(/llama\.cpp b12359 · 17 MB download/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download engine runtime" }));
    expect(engine.installManagedRuntime).toHaveBeenCalledTimes(1);
  });

  it("shows progress and a cancel button while the runtime downloads", () => {
    renderSection({
      status: status({ engineInstalled: false }),
      downloads: { engine: { phase: "downloading", downloaded: 8_000_000, total: 16_000_000 } },
    });
    const bar = screen.getByRole("progressbar", { name: "Engine runtime download" });
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    fireEvent.click(screen.getByRole("button", { name: "Cancel engine runtime download" }));
    expect(engine.cancelManagedDownload).toHaveBeenCalledWith("engine");
    // Models cannot start their own download while the runtime is in flight.
    expect(within(row("Qwen2.5 1.5B Instruct")).getByRole("button", { name: /Download/ })).toBeDisabled();
  });

  it("marks the runtime installed", () => {
    renderSection();
    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download engine runtime" })).toBeNull();
  });
});

describe("ManagedEngineSection — model list", () => {
  it("lists each model with size, source, licence and memory guidance", () => {
    renderSection({ hardware: { ...hardware, totalRamBytes: 8 * GIB } });
    const small = within(row("Qwen2.5 1.5B Instruct"));
    expect(small.getByText("1.1 GB")).toBeInTheDocument();
    expect(small.getByText("Runs well on this machine")).toBeInTheDocument();
    expect(small.getByText("Qwen/Qwen2.5-1.5B-Instruct-GGUF · Apache-2.0")).toBeInTheDocument();
    const large = within(row("Qwen3 8B"));
    expect(large.getByText("5.0 GB")).toBeInTheDocument();
    expect(large.getByText("Needs 12 GB of memory")).toBeInTheDocument();
  });

  it("warns when a model fits but below the recommended memory", () => {
    renderSection({ hardware: { ...hardware, totalRamBytes: 12 * GIB } });
    expect(within(row("Qwen3 8B")).getByText("May be slow · 16 GB recommended")).toBeInTheDocument();
  });

  it("unsupported hardware: a model that cannot fit can be neither downloaded nor started", () => {
    renderSection({
      hardware: { ...hardware, totalRamBytes: 8 * GIB },
      models: [model(SMALL, { installed: true }), model(LARGE)],
    });
    expect(within(row("Qwen3 8B")).getByRole("button", { name: "Download Qwen3 8B" })).toBeDisabled();
    renderSection({
      hardware: { ...hardware, totalRamBytes: 8 * GIB },
      models: [model(LARGE, { installed: true })],
    });
    expect(screen.getByRole("button", { name: "Start Qwen3 8B" })).toBeDisabled();
  });

  it("downloads a model that is not installed", () => {
    renderSection();
    const button = within(row("Qwen2.5 1.5B Instruct")).getByRole("button", {
      name: "Download Qwen2.5 1.5B Instruct",
    });
    expect(button).toHaveTextContent("Download · 1.1 GB");
    fireEvent.click(button);
    expect(engine.downloadManagedModel).toHaveBeenCalledWith(SMALL);
  });

  it("shows byte progress and lets the download be cancelled", () => {
    renderSection({
      downloads: { [SMALL]: { phase: "downloading", downloaded: 412_000_000, total: 1_117_320_736 } },
    });
    const small = within(row("Qwen2.5 1.5B Instruct"));
    expect(small.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "36");
    expect(small.getByText("412 MB of 1.1 GB · 36%")).toBeInTheDocument();
    expect(small.queryByRole("button", { name: /^Download/ })).toBeNull();
    fireEvent.click(small.getByRole("button", { name: "Cancel Qwen2.5 1.5B Instruct download" }));
    expect(engine.cancelManagedDownload).toHaveBeenCalledWith(SMALL);
  });

  it("shows verification as its own step, which cannot be cancelled", () => {
    renderSection({
      downloads: { [SMALL]: { phase: "verifying", downloaded: 1_117_320_736, total: 1_117_320_736 } },
    });
    const small = within(row("Qwen2.5 1.5B Instruct"));
    expect(small.getByText("Verifying checksum…")).toBeInTheDocument();
    expect(small.getByRole("button", { name: /Cancel/ })).toBeDisabled();
  });

  it("offers to resume (or discard) an interrupted download", () => {
    renderSection({ models: [model(SMALL, { partialBytes: 558_660_368 }), model(LARGE)] });
    const small = within(row("Qwen2.5 1.5B Instruct"));
    const resume = small.getByRole("button", { name: "Resume Qwen2.5 1.5B Instruct download" });
    expect(resume).toHaveTextContent("Resume · 50% done");
    fireEvent.click(resume);
    expect(engine.downloadManagedModel).toHaveBeenCalledWith(SMALL);
    fireEvent.click(small.getByRole("button", { name: "Discard partial Qwen2.5 1.5B Instruct download" }));
    expect(engine.deleteManagedModel).toHaveBeenCalledWith(SMALL);
  });

  it("starts or deletes an installed model", () => {
    renderSection({ models: [model(SMALL, { installed: true }), model(LARGE)] });
    const small = within(row("Qwen2.5 1.5B Instruct"));
    fireEvent.click(small.getByRole("button", { name: "Start Qwen2.5 1.5B Instruct" }));
    expect(engine.startManagedEngine).toHaveBeenCalledWith(SMALL);
    fireEvent.click(small.getByRole("button", { name: "Delete Qwen2.5 1.5B Instruct" }));
    expect(engine.deleteManagedModel).toHaveBeenCalledWith(SMALL);
  });
});

describe("ManagedEngineSection — engine state", () => {
  it("running: badge, stop, and the loaded model cannot be deleted", () => {
    renderSection({
      status: status({ phase: "running", modelId: SMALL, port: 51234 }),
      models: [model(SMALL, { installed: true }), model(LARGE, { installed: true })],
    });
    expect(screen.getAllByText("Running")).toHaveLength(2); // header + row
    const small = within(row("Qwen2.5 1.5B Instruct"));
    expect(small.getByRole("button", { name: "Delete Qwen2.5 1.5B Instruct" })).toBeDisabled();
    fireEvent.click(small.getByRole("button", { name: "Stop engine" }));
    expect(engine.stopManagedEngine).toHaveBeenCalledTimes(1);
    // Another installed model can be started (the engine swaps) and deleted.
    const large = within(row("Qwen3 8B"));
    expect(large.getByRole("button", { name: "Start Qwen3 8B" })).toBeEnabled();
    expect(large.getByRole("button", { name: "Delete Qwen3 8B" })).toBeEnabled();
  });

  it("starting: says the model is loading, offers stop, blocks other starts", () => {
    renderSection({
      status: status({ phase: "starting", modelId: SMALL }),
      models: [model(SMALL, { installed: true }), model(LARGE, { installed: true })],
    });
    expect(screen.getByText("Starting")).toBeInTheDocument();
    const small = within(row("Qwen2.5 1.5B Instruct"));
    expect(small.getByText("Loading the model…")).toBeInTheDocument();
    expect(small.getByRole("button", { name: "Stop engine" })).toBeEnabled();
    expect(within(row("Qwen3 8B")).getByRole("button", { name: "Start Qwen3 8B" })).toBeDisabled();
  });

  it("restarting after a crash: says so, with the attempt number", () => {
    renderSection({
      status: status({ phase: "restarting", modelId: SMALL, restarts: 2 }),
      models: [model(SMALL, { installed: true }), model(LARGE)],
    });
    expect(screen.getByText("Restarting")).toBeInTheDocument();
    expect(screen.getByText(/stopped unexpectedly\. Restarting \(attempt 2\)/)).toBeInTheDocument();
  });

  it("failed: badge plus the reason, and the model can be started again", () => {
    renderSection({
      status: status({
        phase: "failed",
        modelId: SMALL,
        error: { code: "crashed", message: "The engine stopped unexpectedly 4 times in a row." },
      }),
      models: [model(SMALL, { installed: true }), model(LARGE)],
      errors: { engine: { code: "crashed", message: "The engine stopped unexpectedly 4 times in a row." } },
    });
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The engine keeps stopping");
    expect(screen.getByRole("alert")).toHaveTextContent("4 times in a row");
    expect(screen.getByRole("button", { name: "Start Qwen2.5 1.5B Instruct" })).toBeEnabled();
  });
});

describe("ManagedEngineSection — error states", () => {
  it("insufficient disk: says how much is needed and how much there is", () => {
    renderSection({
      errors: {
        [SMALL]: {
          code: "insufficient_disk",
          message: "Not enough free disk space for this download.",
          neededBytes: 1_385_756_192,
          availableBytes: 310_000_000,
        },
      },
    });
    const alert = within(row("Qwen2.5 1.5B Instruct")).getByRole("alert");
    expect(alert).toHaveTextContent("Not enough disk space");
    expect(alert).toHaveTextContent("This needs 1.4 GB free and 310 MB is available.");
    // The download can be retried once space is freed.
    expect(within(row("Qwen2.5 1.5B Instruct")).getByRole("button", { name: /Download/ })).toBeEnabled();
  });

  it("hash mismatch: says the file was rejected", () => {
    renderSection({
      errors: {
        [SMALL]: { code: "hash_mismatch", message: "The file does not match its expected checksum." },
      },
    });
    const alert = within(row("Qwen2.5 1.5B Instruct")).getByRole("alert");
    expect(alert).toHaveTextContent("Verification failed");
    expect(alert).toHaveTextContent("does not match its expected checksum");
    expect(alert).toHaveTextContent("Nothing unverified is ever loaded.");
  });

  it("hash mismatch at start (file damaged on disk) is shown for the engine", () => {
    renderSection({
      errors: {
        engine: {
          code: "hash_mismatch",
          message: "The model file was changed or damaged on disk, so it was removed. Download it again.",
        },
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("so it was removed. Download it again.");
  });

  it.each<[string, ManagedEngineError, string, string]>([
    [
      "startup failure",
      { code: "startup_failed", message: "The engine exited while starting (exit status: 1): error loading model" },
      "The engine could not start",
      "error loading model",
    ],
    [
      "port failure",
      { code: "port_unavailable", message: "The engine could not bind its local port." },
      "No local port available",
      "Try starting it again",
    ],
    [
      "insufficient memory",
      { code: "insufficient_memory", message: "x", neededBytes: 12 * GIB, availableBytes: 8 * GIB },
      "Not enough memory",
      "needs 12 GB of memory and this machine has 8 GB",
    ],
    [
      "engine integrity failure",
      { code: "engine_invalid", message: "The engine's code signature is missing or broken." },
      "The engine failed its integrity check",
      "code signature is missing or broken",
    ],
    [
      "network failure",
      { code: "network", message: "The download was interrupted: connection reset" },
      "Download interrupted",
      "What was downloaded so far is kept.",
    ],
  ])("%s: clear title and detail", (_name, error, title, detail) => {
    renderSection({ errors: { engine: error } });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(title);
    expect(alert).toHaveTextContent(detail);
  });

  it("an error can be dismissed", () => {
    renderSection({ errors: { engine: { code: "startup_failed", message: "x" } } });
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Dismiss" }));
    expect(engine.dismissManagedError).toHaveBeenCalledWith("engine");
  });

  it("a failed probe is reported instead of an endless spinner", () => {
    renderSection({
      hardware: null,
      status: null,
      models: [],
      errors: { engine: { code: "io", message: "llm_hardware_info not allowed" } },
    });
    expect(screen.queryByText(/Checking this machine/)).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("llm_hardware_info not allowed");
  });
});
