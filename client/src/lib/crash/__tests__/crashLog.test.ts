import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CRASH_LOG_CAPACITY,
  CRASH_LOG_STORAGE_KEY,
  clearCrashRecords,
  copyDiagnostics,
  formatDiagnostics,
  getCrashCount,
  getCrashRecords,
  recordCrash,
  resetCrashLogForTests,
  subscribeCrashLog,
} from "../crashLog";

const HEX64 = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
const NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
const DM_TEXT = "meet me at the usual place at noon";

function stored(): unknown[] {
  return JSON.parse(localStorage.getItem(CRASH_LOG_STORAGE_KEY) ?? "[]") as unknown[];
}

describe("crashLog", () => {
  beforeEach(() => {
    localStorage.clear();
    resetCrashLogForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("records the fields a report needs", () => {
    window.history.replaceState(null, "", `/profile/${HEX64}`);
    const record = recordCrash(new TypeError("Cannot read properties of undefined (reading 'name')"), {
      source: "boundary",
      boundary: "item:note",
      componentStack: "\n    at NoteCard (http://localhost/src/NoteCard.tsx:1:1)\n    at NotesFeed",
    });
    expect(record).toMatchObject({
      source: "boundary",
      boundary: "item:note",
      name: "TypeError",
      message: "Cannot read properties of undefined (reading 'name')",
      appVersion: "0.0.0-test",
      route: "/profile/:id",
      count: 1,
      ts: Date.now(),
    });
    expect(record?.stack).toMatch(/^at /);
    expect(record?.componentStack).toContain("at NoteCard");
  });

  it("is bounded: the oldest records fall off", () => {
    for (let i = 0; i < CRASH_LOG_CAPACITY + 25; i++) {
      // Spread out in time so neither dedupe nor the burst limiter applies.
      vi.advanceTimersByTime(61_000);
      recordCrash(new Error(`failure number ${i}`), { source: "boundary", boundary: "panel:center" });
    }
    const records = getCrashRecords();
    expect(records).toHaveLength(CRASH_LOG_CAPACITY);
    expect(records[0].message).toBe("failure number 25");
    expect(records[records.length - 1].message).toBe(`failure number ${CRASH_LOG_CAPACITY + 24}`);
    expect(stored()).toHaveLength(CRASH_LOG_CAPACITY);
  });

  it("folds an identical repeat into one record", () => {
    const error = new Error("same failure");
    recordCrash(error, { source: "boundary", boundary: "item:note" });
    vi.advanceTimersByTime(5_000);
    recordCrash(error, { source: "boundary", boundary: "item:note" });
    recordCrash(error, { source: "boundary", boundary: "item:note" });
    const records = getCrashRecords();
    expect(records).toHaveLength(1);
    expect(records[0].count).toBe(3);
    expect(records[0].lastTs - records[0].ts).toBe(5_000);
  });

  it("does not fold crashes from different boundaries", () => {
    const error = new Error("same failure");
    recordCrash(error, { source: "boundary", boundary: "item:note" });
    recordCrash(error, { source: "boundary", boundary: "panel:sidebar" });
    expect(getCrashCount()).toBe(2);
  });

  it("limits a burst of distinct crashes so a render loop cannot thrash storage", () => {
    for (let i = 0; i < 200; i++) {
      recordCrash(new Error(`loop ${i}`), { source: "boundary", boundary: "panel:center" });
    }
    expect(getCrashCount()).toBe(20);
    vi.advanceTimersByTime(11_000);
    expect(recordCrash(new Error("after the burst"), { source: "window.error" })).not.toBeNull();
  });

  it("persists across a reload and re-redacts what it reads back", () => {
    recordCrash(new Error("survives reload"), { source: "unhandledrejection" });
    resetCrashLogForTests();
    expect(getCrashRecords()[0]).toMatchObject({ message: "survives reload", source: "unhandledrejection" });

    // Storage is writable by anything on the origin: a tampered entry must
    // not come back out unredacted.
    localStorage.setItem(
      CRASH_LOG_STORAGE_KEY,
      JSON.stringify([
        { ts: 1, source: "boundary", name: "Error", message: `leak ${NSEC} "${DM_TEXT}"`, route: `/dm/${HEX64}`, stack: `at f (http://x/a.js?tk=${HEX64}:1:1)` },
        "garbage",
        { nope: true },
      ]),
    );
    resetCrashLogForTests();
    const text = JSON.stringify(getCrashRecords());
    expect(getCrashCount()).toBe(1);
    expect(text).not.toContain(NSEC);
    expect(text).not.toContain(DM_TEXT);
    expect(text).not.toContain(HEX64);
  });

  it("survives corrupt or unavailable storage", () => {
    localStorage.setItem(CRASH_LOG_STORAGE_KEY, "{not json");
    resetCrashLogForTests();
    expect(getCrashRecords()).toEqual([]);

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => recordCrash(new Error("still recorded in memory"), { source: "window.error" })).not.toThrow();
    expect(getCrashCount()).toBe(1);
    setItem.mockRestore();
  });

  it("never stores keys, DM plaintext or event content", () => {
    const event = { id: HEX64, pubkey: HEX64, content: DM_TEXT, tags: [["p", HEX64]] };
    const error = new SyntaxError(`Unexpected token 'm', "${DM_TEXT}" is not valid JSON`);
    error.stack = `SyntaxError: Unexpected token 'm', "${DM_TEXT}" is not valid JSON\n${DM_TEXT}\n    at decryptRumor (http://localhost:1420/src/lib/nostr/giftWrap.ts?tk=${HEX64}:12:3)`;
    // Extra own properties on an error are exactly where payloads hide.
    Object.assign(error, { event, secretKey: NSEC, plaintext: DM_TEXT });

    recordCrash(error, { source: "boundary", boundary: "item:dm-message" });
    recordCrash(new Error(`signer failed for ${NSEC} via bunker://${HEX64}?secret=hunter2`), { source: "unhandledrejection" });
    recordCrash(new Error(JSON.stringify(event)), { source: "window.error" });
    // Thrown values that are not errors are data: only their type is kept.
    recordCrash(DM_TEXT, { source: "unhandledrejection" });
    recordCrash(event, { source: "unhandledrejection" });
    recordCrash([DM_TEXT], { source: "unhandledrejection" });
    recordCrash(null, { source: "unhandledrejection" });

    const everything = [
      JSON.stringify(getCrashRecords()),
      localStorage.getItem(CRASH_LOG_STORAGE_KEY) ?? "",
      formatDiagnostics(),
    ].join("\n");

    for (const secret of [DM_TEXT, "usual place", NSEC, HEX64, "hunter2", "bunker://"]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).toContain("Non-Error value thrown (string)");
    expect(everything).toContain("Non-Error value thrown (object)");
    expect(everything).toContain("Non-Error value thrown (array)");
    expect(everything).toContain("Non-Error value thrown (null)");
    expect(everything).toContain("at decryptRumor (http://localhost:1420/src/lib/nostr/giftWrap.ts:12:3)");
  });

  it("passes only the redacted summary on to the debug logger", () => {
    const spy = vi.mocked(console.error);
    recordCrash(new Error(`boom "${DM_TEXT}" ${NSEC}`), { source: "boundary", boundary: "item:note" });
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain("[crash]");
    expect(logged).not.toContain(DM_TEXT);
    expect(logged).not.toContain(NSEC);
  });

  it("accepts error-shaped objects from another realm", () => {
    const foreign = { name: "DOMException", message: "The operation was aborted", stack: "    at f (http://localhost/a.js:1:1)" };
    expect(recordCrash(foreign, { source: "window.error" })).toMatchObject({
      name: "DOMException",
      message: "The operation was aborted",
    });
  });

  it("formats diagnostics newest first with version, route and repeat count", () => {
    expect(formatDiagnostics()).toContain("No crashes recorded.");

    recordCrash(new Error("older"), { source: "window.error" });
    vi.advanceTimersByTime(61_000);
    const newer = new Error("newer");
    recordCrash(newer, { source: "boundary", boundary: "panel:sidebar" });
    recordCrash(newer, { source: "boundary", boundary: "panel:sidebar" });

    const text = formatDiagnostics();
    expect(text).toContain("version: 0.0.0-test (web)");
    expect(text).toContain("crash records: 2");
    expect(text.indexOf("Error: newer")).toBeLessThan(text.indexOf("Error: older"));
    expect(text).toMatch(/#1 2026-11-14T12:01:01\.000Z \[boundary panel:sidebar\] route=\/ v0\.0\.0-test x2/);
  });

  it("copies diagnostics to the clipboard and reports failure", async () => {
    vi.useRealTimers();
    recordCrash(new Error("to copy"), { source: "window.error" });

    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, userAgent: "test-agent", clipboard: { writeText } });
    await expect(copyDiagnostics()).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Error: to copy"));

    writeText.mockRejectedValueOnce(new Error("denied"));
    await expect(copyDiagnostics()).resolves.toBe(false);

    vi.stubGlobal("navigator", { userAgent: "test-agent" });
    await expect(copyDiagnostics()).resolves.toBe(false);
    vi.unstubAllGlobals();
  });

  it("notifies subscribers and clears", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCrashLog(listener);
    recordCrash(new Error("one"), { source: "window.error" });
    expect(listener).toHaveBeenCalledTimes(1);
    clearCrashRecords();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getCrashCount()).toBe(0);
    expect(stored()).toEqual([]);
    unsubscribe();
    recordCrash(new Error("two"), { source: "window.error" });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
