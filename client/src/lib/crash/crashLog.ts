/**
 * Local crash log.
 *
 * A bounded ring buffer of redacted error records, persisted to localStorage
 * so a crash that forces a reload can still be reported afterwards. Nothing
 * here leaves the device: the only way out is the user pressing
 * "Copy diagnostics" and pasting the text somewhere themselves.
 *
 * What a record holds is fixed by construction, not by filtering after the
 * fact. `recordCrash` reads `name`, `message` and `stack` off an `Error` and
 * nothing else: no props, no Redux state, no event objects, no rejection
 * payloads. Those three strings then go through `redact.ts`, which strips
 * keys, identifiers, URLs, addresses and quoted text but keeps an error's
 * unquoted wording (best effort: see `redactMessage`). A thrown value that is
 * not an `Error` is described by its type only, because a bare thrown string
 * or object is usually data.
 */
import { createLogger, registerDebugCommand } from "@/lib/debug/logger";
import {
  redactComponentStack,
  redactMessage,
  redactStack,
  sanitizeName,
  sanitizeRoute,
} from "./redact";

export type CrashSource = "boundary" | "window.error" | "unhandledrejection";

export interface CrashRecord {
  /** Wall-clock time of the first occurrence (epoch ms). */
  ts: number;
  /** Wall-clock time of the latest occurrence when repeats were folded in. */
  lastTs: number;
  /** How many consecutive identical crashes this record stands for. */
  count: number;
  source: CrashSource;
  /** Which boundary caught it, e.g. `panel:sidebar` or `item:note`. */
  boundary?: string;
  name: string;
  message: string;
  stack?: string;
  componentStack?: string;
  appVersion: string;
  /** Route pattern, never the concrete path (see `sanitizeRoute`). */
  route: string;
}

export interface CrashContext {
  source: CrashSource;
  boundary?: string;
  componentStack?: string | null;
}

export const CRASH_LOG_CAPACITY = 30;
export const CRASH_LOG_STORAGE_KEY = "wired:crashlog";

/** Hard ceiling on new records per window, so a storm of distinct errors cannot flood the log. */
const BURST_LIMIT = 20;
const BURST_WINDOW_MS = 10_000;
/** At most one storage write per interval: one at once, then one trailing write for whatever followed. */
const PERSIST_INTERVAL_MS = 1_000;
/** Bound on the raw-fingerprint fast path (see `recordCrash`). */
const FINGERPRINT_CACHE_MAX = 64;

const log = createLogger("crash");

let records: CrashRecord[] | null = null;
let burstStart = 0;
let burstCount = 0;
let lastPersistAt = Number.NEGATIVE_INFINITY;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
/**
 * Raw (unredacted) fingerprint of a thrown value → the record it folded into.
 * Memory only, never persisted. It lets a repeat be recognised without paying
 * for redaction again, which is what makes a storm of identical errors cheap.
 */
const fingerprints = new Map<string, CrashRecord>();
const listeners = new Set<() => void>();

function appVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown";
}

function currentRoute(): string {
  return sanitizeRoute(typeof location !== "undefined" ? location.pathname : "/");
}

function isRecord(value: unknown): value is CrashRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.ts === "number" &&
    typeof r.message === "string" &&
    typeof r.name === "string" &&
    typeof r.source === "string"
  );
}

/**
 * Re-redact a record read back from storage. The stored copy was already
 * redacted, but storage is writable by anything on the origin, so nothing read
 * from it is trusted to be clean.
 */
function rehydrate(value: CrashRecord): CrashRecord {
  const source: CrashSource =
    value.source === "window.error" || value.source === "unhandledrejection"
      ? value.source
      : "boundary";
  return {
    ts: value.ts,
    lastTs: typeof value.lastTs === "number" ? value.lastTs : value.ts,
    count: typeof value.count === "number" && value.count > 0 ? Math.floor(value.count) : 1,
    source,
    boundary: typeof value.boundary === "string" ? sanitizeLabel(value.boundary) : undefined,
    name: sanitizeName(value.name),
    message: redactMessage(value.message, value.name),
    stack: redactStack(value.stack),
    componentStack: redactComponentStack(value.componentStack),
    appVersion: typeof value.appVersion === "string" ? value.appVersion.slice(0, 40) : "unknown",
    route: sanitizeRoute(value.route),
  };
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^\w:.-]/g, "").slice(0, 60);
}

function load(): CrashRecord[] {
  if (records) return records;
  records = [];
  try {
    const raw =
      typeof localStorage !== "undefined" ? localStorage.getItem(CRASH_LOG_STORAGE_KEY) : null;
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        records = parsed.filter(isRecord).map(rehydrate).slice(-CRASH_LOG_CAPACITY);
      }
    }
  } catch {
    records = [];
  }
  return records;
}

function persist(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(CRASH_LOG_STORAGE_KEY, JSON.stringify(records ?? []));
  } catch {
    /* storage full or unavailable: the in-memory buffer still works */
  }
}

/**
 * Write the buffer to storage now, if it has unsaved changes. Called on
 * `pagehide` so a queued write is not lost when the page goes away.
 */
export function flushCrashLog(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!dirty) return;
  dirty = false;
  lastPersistAt = Date.now();
  persist();
}

/**
 * Persist soon, but not once per crash. The first change after a quiet spell
 * is written immediately, because the crash being recorded may be about to
 * take the page down. Anything else inside the interval shares one trailing
 * write. A serialise-and-store per record would turn 200 cards failing in one
 * commit into 200 synchronous writes on the main thread.
 */
function schedulePersist(): void {
  dirty = true;
  if (persistTimer !== null) return;
  const sinceLast = Date.now() - lastPersistAt;
  if (sinceLast >= PERSIST_INTERVAL_MS) {
    flushCrashLog();
    return;
  }
  persistTimer = setTimeout(flushCrashLog, PERSIST_INTERVAL_MS - sinceLast);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Describe a thrown value without reading anything but an Error's own fields. */
function describe(thrown: unknown): { name: string; message: string; stack?: string } {
  if (thrown instanceof Error) {
    return {
      name: sanitizeName(thrown.name),
      message: redactMessage(thrown.message, thrown.name),
      stack: redactStack(thrown.stack),
    };
  }
  // DOMException is not an Error subclass in every engine, and errors from
  // another realm (an iframe, a worker message) fail `instanceof`.
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    typeof (thrown as { message?: unknown }).message === "string" &&
    typeof (thrown as { name?: unknown }).name === "string" &&
    typeof (thrown as { stack?: unknown }).stack === "string"
  ) {
    const e = thrown as { name: string; message: string; stack: string };
    return {
      name: sanitizeName(e.name),
      message: redactMessage(e.message, e.name),
      stack: redactStack(e.stack),
    };
  }
  // Anything else is a value, and values are data. Record its type only.
  const kind = thrown === null ? "null" : Array.isArray(thrown) ? "array" : typeof thrown;
  return { name: "NonErrorThrown", message: `Non-Error value thrown (${kind})` };
}

/** Cheap identity of a thrown value, from its raw fields. Memory only. */
function fingerprintOf(thrown: unknown, context: CrashContext): string | null {
  if (typeof thrown !== "object" || thrown === null) return null;
  const { name, message, stack } = thrown as { name?: unknown; message?: unknown; stack?: unknown };
  if (typeof message !== "string") return null;
  return [context.source, context.boundary ?? "", String(name), message, String(stack)].join("\u0000");
}

/** Count a repeat against an existing record and move it to the newest slot. */
function foldInto(list: CrashRecord[], record: CrashRecord, now: number): CrashRecord {
  record.count += 1;
  record.lastTs = now;
  const index = list.indexOf(record);
  if (index !== -1 && index !== list.length - 1) {
    list.splice(index, 1);
    list.push(record);
  }
  schedulePersist();
  return record;
}

/**
 * Add a crash to the log. Returns the stored record, or `null` when it was
 * dropped by the burst limiter.
 *
 * A repeat of a crash already in the buffer is folded into that record
 * wherever it sits, not only when it is the latest one. Failed boundaries are
 * retried on every navigation, so two items that fail deterministically would
 * otherwise alternate A, B, A, B and push everything else out of the ring.
 */
export function recordCrash(thrown: unknown, context: CrashContext): CrashRecord | null {
  const list = load();
  const now = Date.now();

  // Fast path: the same raw error seen before. No redaction, no storage write.
  const fingerprint = fingerprintOf(thrown, context);
  const known = fingerprint ? fingerprints.get(fingerprint) : undefined;
  if (known && list.includes(known)) return foldInto(list, known, now);

  const described = describe(thrown);
  const boundary = context.boundary ? sanitizeLabel(context.boundary) : undefined;

  let match: CrashRecord | undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const candidate = list[i];
    if (
      candidate.source === context.source &&
      candidate.boundary === boundary &&
      candidate.name === described.name &&
      candidate.message === described.message &&
      candidate.stack === described.stack
    ) {
      match = candidate;
      break;
    }
  }
  if (match) {
    if (fingerprint) remember(fingerprint, match);
    return foldInto(list, match, now);
  }

  if (now - burstStart > BURST_WINDOW_MS) {
    burstStart = now;
    burstCount = 0;
  }
  burstCount += 1;
  if (burstCount > BURST_LIMIT) return null;

  const record: CrashRecord = {
    ts: now,
    lastTs: now,
    count: 1,
    source: context.source,
    boundary,
    name: described.name,
    message: described.message,
    stack: described.stack,
    componentStack: redactComponentStack(context.componentStack),
    appVersion: appVersion(),
    route: currentRoute(),
  };

  list.push(record);
  if (list.length > CRASH_LOG_CAPACITY) list.splice(0, list.length - CRASH_LOG_CAPACITY);
  if (fingerprint) remember(fingerprint, record);
  schedulePersist();

  // Error level always reaches the wiredDebug trace buffer, so a crash shows
  // up in `wiredDebug.dump()` alongside whatever led to it. Only the redacted
  // summary is passed on: the raw error never enters the trace. Logged once
  // per record, not once per repeat.
  log.error(`${record.name}: ${record.message}`, {
    source: record.source,
    boundary: record.boundary,
    route: record.route,
  });

  notify();
  return record;
}

function remember(fingerprint: string, record: CrashRecord): void {
  if (fingerprints.size >= FINGERPRINT_CACHE_MAX) fingerprints.clear();
  fingerprints.set(fingerprint, record);
}

/** Least recently seen first. The returned array is a copy. */
export function getCrashRecords(): CrashRecord[] {
  return load().map((r) => ({ ...r }));
}

export function getCrashCount(): number {
  return load().length;
}

export function clearCrashRecords(): void {
  records = [];
  burstCount = 0;
  fingerprints.clear();
  // Clearing is a deliberate user action: write it through at once.
  dirty = true;
  flushCrashLog();
  notify();
}

/** Subscribe to log changes. Shaped for `useSyncExternalStore`. */
export function subscribeCrashLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function platform(): string {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return "desktop";
  return "web";
}

/** The text behind "Copy diagnostics". Built only from redacted records. */
export function formatDiagnostics(): string {
  const list = load();
  const lines: string[] = [
    "The Wired diagnostics",
    `version: ${appVersion()} (${platform()})`,
    `generated: ${new Date().toISOString()}`,
    `user agent: ${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}`,
    `route: ${currentRoute()}`,
    `crash records: ${list.length}`,
  ];

  if (list.length === 0) {
    lines.push("", "No crashes recorded.");
    return lines.join("\n");
  }

  // Most recently seen first: the crash being reported is almost always the latest one.
  [...list].reverse().forEach((r, i) => {
    const where = r.boundary ? `${r.source} ${r.boundary}` : r.source;
    const repeat =
      r.count > 1 ? ` x${r.count} (last ${new Date(r.lastTs).toISOString()})` : "";
    lines.push(
      "",
      `#${i + 1} ${new Date(r.ts).toISOString()} [${where}] route=${r.route} v${r.appVersion}${repeat}`,
      `${r.name}: ${r.message}`,
    );
    if (r.stack) lines.push(...r.stack.split("\n").map((frame) => `  ${frame}`));
    if (r.componentStack) {
      lines.push("  component stack:");
      lines.push(...r.componentStack.split("\n").map((frame) => `    ${frame}`));
    }
  });

  return lines.join("\n");
}

/** Copy the diagnostics text to the clipboard. Resolves `false` when the clipboard is unavailable. */
export async function copyDiagnostics(): Promise<boolean> {
  const text = formatDiagnostics();
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// `wiredDebug.crashes()` in the console: same text as the Copy diagnostics button.
registerDebugCommand("crashes", () => {
  void copyDiagnostics();
  return formatDiagnostics();
});

/** Test seam: drop the in-memory buffer so the next read reloads from storage. */
export function resetCrashLogForTests(): void {
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = null;
  dirty = false;
  lastPersistAt = Number.NEGATIVE_INFINITY;
  records = null;
  burstStart = 0;
  burstCount = 0;
  fingerprints.clear();
  listeners.clear();
}
