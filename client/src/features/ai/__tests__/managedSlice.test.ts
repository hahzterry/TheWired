import { describe, it, expect } from "vitest";
import { createTestStore } from "@/__tests__/helpers/createTestStore";
import {
  resetManagedEngine,
  selectManagedEngine,
  setManagedDownload,
  setManagedError,
  setManagedHardware,
  setManagedModels,
  setManagedStatus,
} from "@/store/slices/aiSlice";
import type { ManagedEngineStatus, ManagedHardware, ManagedModel } from "@/types/ai";

const hardware: ManagedHardware = {
  os: "macos",
  arch: "aarch64",
  totalRamBytes: 16 * 1024 ** 3,
  cpuCores: 10,
  freeDiskBytes: 200e9,
  acceleration: "metal",
  engineSupported: true,
  engineBuild: "b12359",
  engineDownloadBytes: 16_907_811,
};

const status: ManagedEngineStatus = {
  phase: "running",
  modelId: "qwen2.5-1.5b-instruct-q4",
  port: 51234,
  restarts: 0,
  error: null,
  engineInstalled: true,
  engineBuild: "b12359",
};

const model: ManagedModel = {
  id: "qwen2.5-1.5b-instruct-q4",
  name: "Qwen2.5 1.5B Instruct",
  description: "Small and fast.",
  source: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
  license: "Apache-2.0",
  sizeBytes: 1_117_320_736,
  minRamBytes: 4 * 1024 ** 3,
  recommendedRamBytes: 8 * 1024 ** 3,
  reasoning: false,
  installed: true,
  partialBytes: 0,
};

describe("aiSlice — managed engine state", () => {
  it("starts empty: nothing is shown until the native side reports", () => {
    const store = createTestStore();
    expect(selectManagedEngine(store.getState())).toEqual({
      hardware: null,
      status: null,
      models: [],
      downloads: {},
      errors: {},
    });
  });

  it("stores hardware, status and the catalogue as reported", () => {
    const store = createTestStore();
    store.dispatch(setManagedHardware(hardware));
    store.dispatch(setManagedStatus(status));
    store.dispatch(setManagedModels([model]));
    const managed = selectManagedEngine(store.getState());
    expect(managed.hardware).toEqual(hardware);
    expect(managed.status).toEqual(status);
    expect(managed.models).toEqual([model]);
  });

  it("replaces the status wholesale so a stale port or error never lingers", () => {
    const store = createTestStore();
    store.dispatch(
      setManagedStatus({
        ...status,
        phase: "failed",
        port: null,
        error: { code: "crashed", message: "kept stopping" },
      }),
    );
    store.dispatch(setManagedStatus({ ...status, phase: "stopped", port: null, modelId: null }));
    const s = selectManagedEngine(store.getState()).status!;
    expect(s.phase).toBe("stopped");
    expect(s.error).toBeNull();
    expect(s.port).toBeNull();
  });

  it("tracks progress per download and clears it when the download ends", () => {
    const store = createTestStore();
    store.dispatch(
      setManagedDownload({ id: "m1", download: { phase: "downloading", downloaded: 10, total: 100 } }),
    );
    store.dispatch(
      setManagedDownload({ id: "engine", download: { phase: "verifying", downloaded: 5, total: 5 } }),
    );
    store.dispatch(
      setManagedDownload({ id: "m1", download: { phase: "downloading", downloaded: 60, total: 100 } }),
    );
    expect(selectManagedEngine(store.getState()).downloads).toEqual({
      m1: { phase: "downloading", downloaded: 60, total: 100 },
      engine: { phase: "verifying", downloaded: 5, total: 5 },
    });

    store.dispatch(setManagedDownload({ id: "m1", download: null }));
    expect(selectManagedEngine(store.getState()).downloads).toEqual({
      engine: { phase: "verifying", downloaded: 5, total: 5 },
    });
    // Clearing something that is not there is a no-op.
    store.dispatch(setManagedDownload({ id: "missing", download: null }));
    expect(Object.keys(selectManagedEngine(store.getState()).downloads)).toEqual(["engine"]);
  });

  it("keeps the last error per target and clears it independently", () => {
    const store = createTestStore();
    store.dispatch(
      setManagedError({
        id: "m1",
        error: { code: "insufficient_disk", message: "full", neededBytes: 10, availableBytes: 4 },
      }),
    );
    store.dispatch(setManagedError({ id: "engine", error: { code: "startup_failed", message: "x" } }));
    expect(selectManagedEngine(store.getState()).errors.m1.neededBytes).toBe(10);

    store.dispatch(setManagedError({ id: "m1", error: null }));
    expect(selectManagedEngine(store.getState()).errors).toEqual({
      engine: { code: "startup_failed", message: "x" },
    });
  });

  it("reset wipes every trace (logout, feature off)", () => {
    const store = createTestStore();
    store.dispatch(setManagedHardware(hardware));
    store.dispatch(setManagedStatus(status));
    store.dispatch(setManagedModels([model]));
    store.dispatch(
      setManagedDownload({ id: "m1", download: { phase: "downloading", downloaded: 1, total: 2 } }),
    );
    store.dispatch(setManagedError({ id: "engine", error: { code: "io", message: "x" } }));
    store.dispatch(resetManagedEngine());
    expect(selectManagedEngine(store.getState())).toEqual({
      hardware: null,
      status: null,
      models: [],
      downloads: {},
      errors: {},
    });
  });

  it("is cleared by the global store reset on logout", () => {
    const store = createTestStore();
    store.dispatch(setManagedStatus(status));
    store.dispatch({ type: "store/RESET_ALL" });
    expect(selectManagedEngine(store.getState()).status).toBeNull();
  });

  it("has no field that could hold the engine's access key", () => {
    // The status shape is the contract: a key field here would put the secret
    // into Redux (and devtools, and any state dump).
    const store = createTestStore();
    store.dispatch(setManagedStatus(status));
    const keys = Object.keys(selectManagedEngine(store.getState()).status!).sort();
    expect(keys).toEqual(
      ["engineBuild", "engineInstalled", "error", "modelId", "phase", "port", "restarts"].sort(),
    );
  });
});
