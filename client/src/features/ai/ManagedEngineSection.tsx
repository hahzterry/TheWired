import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Cpu,
  Download,
  HardDrive,
  Loader2,
  Play,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useAppSelector } from "@/store/hooks";
import { selectManagedEngine } from "@/store/slices/aiSlice";
import type {
  ManagedDownload,
  ManagedEngineError,
  ManagedEngineStatus,
  ManagedHardware,
  ManagedModel,
} from "@/types/ai";
import {
  ENGINE_TARGET,
  cancelManagedDownload,
  deleteManagedModel,
  dismissManagedError,
  downloadManagedModel,
  installManagedRuntime,
  isManagedEngineAvailable,
  startManagedEngine,
  stopManagedEngine,
} from "./engine/managedEngine";
import {
  describeManagedError,
  downloadPercent,
  formatMemory,
  formatSize,
  memoryFit,
  memoryFitLabel,
} from "./managedFormat";

/**
 * Settings for the built-in engine: download the runtime and a model, start and
 * stop it, and see why something failed. Desktop only — on the web there is no
 * native side, so the whole section renders nothing.
 */
export function ManagedEngineSection() {
  const managed = useAppSelector(selectManagedEngine);
  if (!isManagedEngineAvailable()) return null;

  const { hardware, status, models, downloads, errors } = managed;
  // Two sources: a command the user ran that failed (kept in `errors`), and the
  // engine giving up on its own (crash loop), which only the status carries.
  const commandError = errors[ENGINE_TARGET];
  const statusError = status?.phase === "failed" ? status.error : null;
  const engineError = commandError ?? statusError ?? undefined;
  // Dismissing a command error just hides it; dismissing the engine's own
  // failure resets it to Stopped (there is nothing left to stop).
  const dismissEngineError = () =>
    commandError ? dismissManagedError(ENGINE_TARGET) : void stopManagedEngine();

  return (
    <section className="space-y-3" aria-labelledby="managed-engine-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="managed-engine-heading" className="text-sm font-semibold text-heading">
            Built-in engine
          </h3>
          <p className="mt-1 text-xs text-muted">
            Run a model on this machine with nothing else to install. Chats with it never leave
            your device.
          </p>
        </div>
        {status && hardware?.engineSupported && <PhaseBadge status={status} />}
      </div>

      {!hardware ? (
        engineError ? (
          <ErrorBox error={engineError} onDismiss={dismissEngineError} />
        ) : (
          <div className="flex items-center gap-2 rounded-xl bg-field/50 p-4 text-xs text-muted ring-1 ring-border">
            <Loader2 size={14} className="animate-spin" />
            Checking this machine…
          </div>
        )
      ) : !hardware.engineSupported ? (
        <div
          role="status"
          className="rounded-xl bg-field/50 p-4 text-xs text-soft ring-1 ring-border"
        >
          <div className="font-medium text-heading">Not available on this system yet</div>
          <p className="mt-1 text-muted">
            The built-in engine currently runs on macOS and Linux. You can still use local models
            through Ollama or LM Studio (Detect local), or add a cloud provider below.
          </p>
        </div>
      ) : (
        <>
          <HardwareLine hardware={hardware} />
          <RuntimeRow
            hardware={hardware}
            status={status}
            download={downloads[ENGINE_TARGET]}
          />
          {engineError && (
            <ErrorBox error={engineError} onDismiss={dismissEngineError} />
          )}
          <ul className="space-y-2" aria-label="Models">
            {models.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                hardware={hardware}
                status={status}
                download={downloads[model.id]}
                error={errors[model.id]}
                runtimeBusy={!!downloads[ENGINE_TARGET]}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function PhaseBadge({ status }: { status: ManagedEngineStatus }) {
  const base =
    "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold";
  switch (status.phase) {
    case "running":
      return (
        <span className={`${base} bg-green-500/10 text-green-400`}>
          <Check size={10} />
          Running
        </span>
      );
    case "starting":
      return (
        <span className={`${base} bg-primary/10 text-primary`}>
          <Loader2 size={10} className="animate-spin" />
          Starting
        </span>
      );
    case "restarting":
      return (
        <span className={`${base} bg-yellow-400/10 text-yellow-400`}>
          <Loader2 size={10} className="animate-spin" />
          Restarting
        </span>
      );
    case "stopping":
      return (
        <span className={`${base} bg-surface text-muted`}>
          <Loader2 size={10} className="animate-spin" />
          Stopping
        </span>
      );
    case "failed":
      return (
        <span className={`${base} bg-red-500/10 text-red-400`}>
          <AlertTriangle size={10} />
          Failed
        </span>
      );
    default:
      return <span className={`${base} bg-surface text-muted`}>Stopped</span>;
  }
}

function HardwareLine({ hardware }: { hardware: ManagedHardware }) {
  const parts = [
    hardware.acceleration === "metal" ? "Apple Silicon (GPU accelerated)" : "CPU only",
    `${formatMemory(hardware.totalRamBytes)} memory`,
  ];
  if (hardware.freeDiskBytes != null) parts.push(`${formatSize(hardware.freeDiskBytes)} free disk`);
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted">
      <Cpu size={12} className="shrink-0" />
      <span>{parts.join(" · ")}</span>
    </div>
  );
}

function ProgressBar({ download, label }: { download: ManagedDownload; label: string }) {
  const percent = downloadPercent(download.downloaded, download.total);
  return (
    <div className="space-y-1">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-surface"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="text-[11px] tabular-nums text-muted">
        {download.phase === "verifying"
          ? "Verifying checksum…"
          : `${formatSize(download.downloaded)} of ${formatSize(download.total)} · ${percent}%`}
      </div>
    </div>
  );
}

function RuntimeRow({
  hardware,
  status,
  download,
}: {
  hardware: ManagedHardware;
  status: ManagedEngineStatus | null;
  download: ManagedDownload | undefined;
}) {
  const installed = !!status?.engineInstalled;
  return (
    <div className="space-y-2 rounded-xl bg-field p-3 ring-1 ring-border">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-medium text-heading">
            <HardDrive size={13} className="shrink-0 text-muted" />
            Engine runtime
          </div>
          <div className="mt-0.5 text-[11px] text-muted">
            llama.cpp {hardware.engineBuild}
            {hardware.engineDownloadBytes != null &&
              ` · ${formatSize(hardware.engineDownloadBytes)} download`}
          </div>
        </div>
        {installed ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-green-400">
            <Check size={12} />
            Installed
          </span>
        ) : download ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void cancelManagedDownload(ENGINE_TARGET)}
            className="gap-1.5"
            aria-label="Cancel engine runtime download"
          >
            <X size={12} />
            Cancel
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void installManagedRuntime()}
            className="gap-1.5"
            aria-label="Download engine runtime"
          >
            <Download size={12} />
            Download
          </Button>
        )}
      </div>
      {download && !installed && <ProgressBar download={download} label="Engine runtime download" />}
    </div>
  );
}

function ErrorBox({
  error,
  onDismiss,
}: {
  error: ManagedEngineError;
  onDismiss: () => void;
}) {
  const { title, detail } = describeManagedError(error);
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400"
    >
      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{title}</div>
        <div className="mt-0.5 break-words text-red-400/90">{detail}</div>
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 transition-colors hover:bg-red-500/15"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function ModelRow({
  model,
  hardware,
  status,
  download,
  error,
  runtimeBusy,
}: {
  model: ManagedModel;
  hardware: ManagedHardware;
  status: ManagedEngineStatus | null;
  download: ManagedDownload | undefined;
  error: ManagedEngineError | undefined;
  runtimeBusy: boolean;
}) {
  const fit = memoryFit(model, hardware.totalRamBytes);
  const phase = status?.phase ?? "stopped";
  const isEngineModel = status?.modelId === model.id;
  const running = isEngineModel && phase === "running";
  const launching = isEngineModel && (phase === "starting" || phase === "restarting");
  // One engine process: while it is coming up or going down, nothing else starts.
  const engineBusy = phase === "starting" || phase === "restarting" || phase === "stopping";
  const fitTone =
    fit === "good" ? "text-green-400" : fit === "tight" ? "text-yellow-400" : "text-red-400";
  // Removing a model (or a partial download) throws away gigabytes that would
  // have to be fetched again, so it takes a second, explicit click.
  const [confirming, setConfirming] = useState<"delete" | "discard" | null>(null);
  const confirmRemoval = () => {
    setConfirming(null);
    void deleteManagedModel(model.id);
  };

  return (
    <li className="space-y-2.5 rounded-xl bg-field p-3 ring-1 ring-border">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-heading">
            <span>{model.name}</span>
            <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-normal text-muted">
              {formatSize(model.sizeBytes)}
            </span>
            {running && (
              <span className="flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-semibold text-green-400">
                <Check size={9} />
                Running
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted">{model.description}</p>
          <div className={`mt-1 text-[11px] ${fitTone}`}>{memoryFitLabel(fit, model)}</div>
          <div className="mt-0.5 truncate text-[10px] text-faint">
            {model.source} · {model.license}
          </div>
        </div>
      </div>

      {download && <ProgressBar download={download} label={`${model.name} download`} />}

      {launching && (
        <div role="status" className="flex items-center gap-1.5 text-[11px] text-primary">
          <Loader2 size={12} className="animate-spin" />
          {phase === "restarting"
            ? `The engine stopped unexpectedly. Restarting (attempt ${status?.restarts ?? 1})…`
            : "Loading the model…"}
        </div>
      )}

      {error && <ErrorBox error={error} onDismiss={() => dismissManagedError(model.id)} />}

      {confirming && !download && !running && !launching ? (
        <div
          role="group"
          aria-label={`Confirm removing ${model.name}`}
          className="flex flex-wrap items-center gap-2 rounded-lg bg-surface px-3 py-2"
        >
          <span className="min-w-0 flex-1 text-xs text-heading">
            {confirming === "delete"
              ? `Delete ${model.name} (${formatSize(model.sizeBytes)})? You would have to download it again to use it.`
              : `Discard the ${formatSize(model.partialBytes)} of ${model.name} downloaded so far? The download would start over.`}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={confirmRemoval}
            className="gap-1.5 text-red-400"
            aria-label={
              confirming === "delete"
                ? `Confirm delete ${model.name}`
                : `Confirm discard partial ${model.name} download`
            }
          >
            <Trash2 size={12} />
            {confirming === "delete" ? "Delete model" : "Discard"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(null)}
            aria-label={`Keep ${model.name}`}
          >
            Keep
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {download ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void cancelManagedDownload(model.id)}
              disabled={download.phase === "verifying"}
              className="gap-1.5"
              aria-label={`Cancel ${model.name} download`}
            >
              <X size={12} />
              Cancel
            </Button>
          ) : model.installed ? (
            <>
              {running || launching ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void stopManagedEngine()}
                  className="gap-1.5"
                  aria-label="Stop engine"
                >
                  <Square size={12} />
                  Stop
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => void startManagedEngine(model.id)}
                  disabled={fit === "insufficient" || engineBusy}
                  className="gap-1.5"
                  aria-label={`Start ${model.name}`}
                >
                  <Play size={12} />
                  Start
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirming("delete")}
                disabled={running || launching}
                className="gap-1.5"
                aria-label={`Delete ${model.name}`}
              >
                <Trash2 size={12} />
                Delete
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void downloadManagedModel(model.id)}
                disabled={fit === "insufficient" || runtimeBusy}
                className="gap-1.5"
                aria-label={
                  model.partialBytes > 0 ? `Resume ${model.name} download` : `Download ${model.name}`
                }
              >
                <Download size={12} />
                {model.partialBytes > 0
                  ? `Resume · ${downloadPercent(model.partialBytes, model.sizeBytes)}% done`
                  : `Download · ${formatSize(model.sizeBytes)}`}
              </Button>
              {model.partialBytes > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirming("discard")}
                  className="gap-1.5"
                  aria-label={`Discard partial ${model.name} download`}
                >
                  <Trash2 size={12} />
                  Discard
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}
