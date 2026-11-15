import { describe, it, expect } from "vitest";
import {
  describeManagedError,
  downloadPercent,
  formatMemory,
  formatSize,
  memoryFit,
  memoryFitLabel,
} from "../managedFormat";

const GIB = 1024 ** 3;
const small = { minRamBytes: 4 * GIB, recommendedRamBytes: 8 * GIB };

describe("managedFormat", () => {
  it("formats file sizes in decimal units", () => {
    expect(formatSize(1_117_320_736)).toBe("1.1 GB");
    expect(formatSize(5_027_783_488)).toBe("5.0 GB");
    expect(formatSize(212e9)).toBe("212 GB");
    expect(formatSize(16_907_811)).toBe("17 MB");
    expect(formatSize(1)).toBe("1 MB");
    expect(formatSize(0)).toBe("0 MB");
    expect(formatSize(Number.NaN)).toBe("0 MB");
  });

  it("formats memory in whole binary gigabytes", () => {
    expect(formatMemory(16 * GIB)).toBe("16 GB");
    expect(formatMemory(17_179_869_184)).toBe("16 GB");
    expect(formatMemory(7.6 * GIB)).toBe("8 GB");
  });

  it("classifies how well a model fits in this machine's memory", () => {
    expect(memoryFit(small, 16 * GIB)).toBe("good");
    expect(memoryFit(small, 8 * GIB)).toBe("good");
    expect(memoryFit(small, 8 * GIB - 1)).toBe("tight");
    expect(memoryFit(small, 4 * GIB)).toBe("tight");
    expect(memoryFit(small, 4 * GIB - 1)).toBe("insufficient");
    // An unknown reading never blocks; the native side has the final say.
    expect(memoryFit(small, 0)).toBe("good");
  });

  it("words the guidance for each fit", () => {
    expect(memoryFitLabel("good", small)).toBe("Runs well on this machine");
    expect(memoryFitLabel("tight", small)).toBe("May be slow · 8 GB recommended");
    expect(memoryFitLabel("insufficient", small)).toBe("Needs 4 GB of memory");
  });

  it("clamps the download percentage", () => {
    expect(downloadPercent(0, 100)).toBe(0);
    expect(downloadPercent(50, 100)).toBe(50);
    expect(downloadPercent(999, 1000)).toBe(99);
    expect(downloadPercent(1000, 1000)).toBe(100);
    expect(downloadPercent(2000, 1000)).toBe(100);
    expect(downloadPercent(10, 0)).toBe(0);
    expect(downloadPercent(-5, 100)).toBe(0);
  });

  it("gives every failure class a distinct, plain title", () => {
    const codes = [
      "unsupported_platform",
      "insufficient_memory",
      "insufficient_disk",
      "hash_mismatch",
      "engine_invalid",
      "network",
      "not_installed",
      "busy",
      "startup_failed",
      "port_unavailable",
      "crashed",
    ] as const;
    const titles = codes.map((code) => describeManagedError({ code, message: "m" }).title);
    expect(new Set(titles).size).toBe(codes.length);
    for (const title of titles) expect(title).not.toBe("Something went wrong");
    expect(describeManagedError({ code: "io", message: "disk said no" })).toEqual({
      title: "Something went wrong",
      detail: "disk said no",
    });
  });

  it("falls back to generic advice when byte counts are missing", () => {
    expect(describeManagedError({ code: "insufficient_disk", message: "m" }).detail).toBe(
      "Free up space, then try again.",
    );
    expect(describeManagedError({ code: "insufficient_memory", message: "m" }).detail).toBe(
      "Pick a smaller model.",
    );
  });
});
