import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getCrashRecords, resetCrashLogForTests } from "../crashLog";
import { installGlobalErrorHandlers } from "../globalHandlers";

function dispatchError(error: unknown, message = "") {
  // jsdom reports uncaught listener errors through the same event; build it by hand.
  const event = new Event("error") as ErrorEvent;
  Object.defineProperty(event, "error", { value: error });
  Object.defineProperty(event, "message", { value: message });
  window.dispatchEvent(event);
  return event;
}

function dispatchRejection(reason: unknown) {
  const event = new Event("unhandledrejection", { cancelable: true }) as PromiseRejectionEvent;
  Object.defineProperty(event, "reason", { value: reason });
  window.dispatchEvent(event);
  return event;
}

describe("global error handlers", () => {
  let uninstall: () => void;

  beforeEach(() => {
    localStorage.clear();
    resetCrashLogForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
    uninstall = installGlobalErrorHandlers();
  });

  afterEach(() => {
    uninstall();
    vi.restoreAllMocks();
  });

  it("captures window error events", () => {
    dispatchError(new RangeError("Maximum call stack size exceeded"));
    expect(getCrashRecords()).toEqual([
      expect.objectContaining({
        source: "window.error",
        name: "RangeError",
        message: "Maximum call stack size exceeded",
      }),
    ]);
  });

  it("captures unhandled promise rejections", () => {
    dispatchRejection(new Error("relay publish failed"));
    expect(getCrashRecords()).toEqual([
      expect.objectContaining({ source: "unhandledrejection", message: "relay publish failed" }),
    ]);
  });

  it("records only the type of a non-Error rejection reason", () => {
    dispatchRejection({ content: "private message text" });
    const [record] = getCrashRecords();
    expect(record.message).toBe("Non-Error value thrown (object)");
    expect(JSON.stringify(record)).not.toContain("private message text");
  });

  it("falls back to the event message when there is no error object", () => {
    dispatchError(null, "Uncaught SyntaxError: Unexpected end of input");
    expect(getCrashRecords()[0]).toMatchObject({
      source: "window.error",
      message: "Uncaught SyntaxError: Unexpected end of input",
    });
  });

  it("ignores noise: ResizeObserver notices, cross-origin script errors, aborts", () => {
    dispatchError(null, "ResizeObserver loop completed with undelivered notifications.");
    dispatchError(null, "Script error.");
    dispatchRejection(new DOMException("The user aborted a request.", "AbortError"));
    dispatchError(new DOMException("aborted", "AbortError"));
    expect(getCrashRecords()).toEqual([]);
  });

  it("leaves default handling alone so the console still reports the error", () => {
    expect(dispatchRejection(new Error("x")).defaultPrevented).toBe(false);
  });

  it("installs once and uninstalls cleanly", () => {
    installGlobalErrorHandlers();
    installGlobalErrorHandlers();
    dispatchError(new Error("only once"));
    expect(getCrashRecords()).toHaveLength(1);
    expect(getCrashRecords()[0].count).toBe(1);

    uninstall();
    // With no error listener left, the test runner would treat the dispatched
    // event as a genuine uncaught exception. Give it one for this dispatch.
    const sink = () => {};
    window.addEventListener("error", sink);
    dispatchError(new Error("after uninstall"));
    window.removeEventListener("error", sink);
    expect(getCrashRecords()).toHaveLength(1);
  });
});
