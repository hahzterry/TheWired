import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DiagnosticsSection } from "../DiagnosticsSection";
import { getCrashCount, recordCrash, resetCrashLogForTests } from "@/lib/crash/crashLog";

describe("DiagnosticsSection", () => {
  beforeEach(() => {
    localStorage.clear();
    resetCrashLogForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the record count and follows the log as it changes", () => {
    render(<DiagnosticsSection />);
    expect(screen.getByTestId("crash-count")).toHaveTextContent("No crashes recorded");
    expect(screen.getByRole("button", { name: /clear records/i })).toBeDisabled();

    act(() => {
      recordCrash(new Error("first"), { source: "window.error" });
    });
    expect(screen.getByTestId("crash-count")).toHaveTextContent("1 record stored");

    act(() => {
      recordCrash(new Error("second"), { source: "unhandledrejection" });
    });
    expect(screen.getByTestId("crash-count")).toHaveTextContent("2 records stored");
  });

  it("copies the diagnostics text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { userAgent: "test-agent", clipboard: { writeText } });
    recordCrash(new Error("to report"), { source: "boundary", boundary: "panel:center" });

    render(<DiagnosticsSection />);
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain("Error: to report");
    expect(writeText.mock.calls[0][0]).toContain("[boundary panel:center]");
  });

  it("clears the records", () => {
    recordCrash(new Error("to clear"), { source: "window.error" });
    render(<DiagnosticsSection />);
    fireEvent.click(screen.getByRole("button", { name: /clear records/i }));
    expect(getCrashCount()).toBe(0);
    expect(screen.getByTestId("crash-count")).toHaveTextContent("No crashes recorded");
  });
});
