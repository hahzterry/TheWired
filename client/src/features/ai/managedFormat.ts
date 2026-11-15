import type { ManagedEngineError, ManagedModel } from "@/types/ai";

const GIB = 1024 ** 3;

/** File and disk sizes, decimal units (what download pages and Finder show). */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** Memory, binary units rounded to whole gigabytes ("16 GB"). */
export function formatMemory(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / GIB))} GB`;
}

export type MemoryFit = "good" | "tight" | "insufficient";

/**
 * Will this model run here? Total memory is the ceiling (on Apple Silicon the
 * GPU shares it). Below the model's minimum the native side refuses to load it;
 * between minimum and recommended it runs but competes with everything else.
 */
export function memoryFit(
  model: Pick<ManagedModel, "minRamBytes" | "recommendedRamBytes">,
  totalRamBytes: number,
): MemoryFit {
  // An unknown reading (0) must not block: the native side decides for real.
  if (totalRamBytes > 0 && totalRamBytes < model.minRamBytes) return "insufficient";
  if (totalRamBytes > 0 && totalRamBytes < model.recommendedRamBytes) return "tight";
  return "good";
}

export function memoryFitLabel(
  fit: MemoryFit,
  model: Pick<ManagedModel, "minRamBytes" | "recommendedRamBytes">,
): string {
  switch (fit) {
    case "insufficient":
      return `Needs ${formatMemory(model.minRamBytes)} of memory`;
    case "tight":
      return `May be slow · ${formatMemory(model.recommendedRamBytes)} recommended`;
    default:
      return "Runs well on this machine";
  }
}

export function downloadPercent(downloaded: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, Math.floor((downloaded / total) * 100)));
}

/** Plain-language title + detail for each failure the native side reports. */
export function describeManagedError(error: ManagedEngineError): {
  title: string;
  detail: string;
} {
  switch (error.code) {
    case "insufficient_disk":
      return {
        title: "Not enough disk space",
        detail:
          error.neededBytes != null && error.availableBytes != null
            ? `This needs ${formatSize(error.neededBytes)} free and ${formatSize(error.availableBytes)} is available. Free up space, then try again.`
            : "Free up space, then try again.",
      };
    case "insufficient_memory":
      return {
        title: "Not enough memory",
        detail:
          error.neededBytes != null && error.availableBytes != null
            ? `This model needs ${formatMemory(error.neededBytes)} of memory and this machine has ${formatMemory(error.availableBytes)}. Pick a smaller model.`
            : "Pick a smaller model.",
      };
    case "hash_mismatch":
      return {
        title: "Verification failed",
        detail: `${error.message} Nothing unverified is ever loaded.`,
      };
    case "engine_invalid":
      return { title: "The engine failed its integrity check", detail: error.message };
    case "network":
      return {
        title: "Download interrupted",
        detail: `${error.message} What was downloaded so far is kept.`,
      };
    case "unsupported_platform":
      return { title: "Not available on this system", detail: error.message };
    case "port_unavailable":
      return {
        title: "No local port available",
        detail: "The engine could not open a local port. Try starting it again.",
      };
    case "startup_failed":
      return { title: "The engine could not start", detail: error.message };
    case "crashed":
      return { title: "The engine keeps stopping", detail: error.message };
    case "not_installed":
      return { title: "Not downloaded yet", detail: error.message };
    case "busy":
      return { title: "Busy", detail: error.message };
    default:
      return { title: "Something went wrong", detail: error.message };
  }
}
