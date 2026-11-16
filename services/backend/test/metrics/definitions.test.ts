/**
 * The backend's metric catalogue: what is registered, that label values stay
 * inside closed sets, and that docs/METRICS.md lists exactly what the code
 * exports (so the doc cannot drift from the registry).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  registry,
  kindClass,
  methodLabel,
  recordIngestedEvent,
  recordIngestError,
  recordJobFailure,
  runInstrumentedJob,
  ingestEventsTotal,
  ingestHandlerErrors,
  ingestLastEventCreatedAt,
  ingestLastEventTimestamp,
  jobLastSuccess,
  jobLastRunDuration,
  jobRuns,
} from "../../src/lib/metrics/index.js";

const REQUIRED = [
  // HTTP
  "backend_http_requests_total",
  "backend_http_request_duration_seconds",
  // process
  "process_cpu_seconds_total",
  "process_resident_memory_bytes",
  "process_start_time_seconds",
  "nodejs_heap_size_used_bytes",
  "nodejs_eventloop_lag_p99_seconds",
  // dependencies
  "backend_dependency_up",
  "backend_dependency_last_success_timestamp_seconds",
  // relay connection manager
  "backend_ingest_relays_configured",
  "backend_ingest_relays_connected",
  "backend_ingest_relay_reconnects_total",
  // ingest handlers
  "backend_ingest_events_total",
  "backend_ingest_last_event_timestamp_seconds",
  "backend_ingest_last_event_created_at_seconds",
  "backend_ingest_handler_errors_total",
  // notification dispatcher
  "backend_notification_queue_depth",
  "backend_notification_send_failures_total",
  // transcode worker
  "backend_transcode_jobs_total",
  "backend_transcode_job_duration_seconds",
  // periodic computers
  "backend_job_runs_total",
  "backend_job_last_success_timestamp_seconds",
];

describe("metric registration", () => {
  it("registers every metric the task calls for", () => {
    const names = registry.names();
    for (const name of REQUIRED) expect(names, name).toContain(name);
  });

  it("renders a parseable exposition with a TYPE line per metric", () => {
    const out = registry.render();
    for (const name of registry.names()) {
      expect(out).toMatch(new RegExp(`^# TYPE ${name} (counter|gauge|histogram)$`, "m"));
      expect(out).toMatch(new RegExp(`^# HELP ${name} .+$`, "m"));
    }
    // Every sample line is `name{labels} value` with a numeric value.
    for (const line of out.split("\n")) {
      if (line === "" || line.startsWith("#")) continue;
      expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? (-?\d+(\.\d+)?(e[+-]?\d+)?|NaN|[+-]Inf)$/);
    }
  });

  it("exports live process metrics", () => {
    const out = registry.render();
    const value = (name: string) => Number(out.match(new RegExp(`^${name} (.+)$`, "m"))?.[1]);
    expect(value("process_resident_memory_bytes")).toBeGreaterThan(1_000_000);
    expect(value("nodejs_heap_size_used_bytes")).toBeGreaterThan(1_000_000);
    expect(value("process_cpu_seconds_total")).toBeGreaterThan(0);
    const start = value("process_start_time_seconds");
    expect(start).toBeGreaterThan(Date.now() / 1000 - 24 * 3600);
    expect(start).toBeLessThanOrEqual(Date.now() / 1000);
    expect(out).toContain(`nodejs_version_info{version="${process.version}"} 1`);
  });

  // The doc is the operator's reference; a metric added without a doc entry
  // (or documented but removed) fails here.
  it("docs/METRICS.md lists exactly the backend's metrics", () => {
    const doc = readFileSync(resolve(process.cwd(), "../../docs/METRICS.md"), "utf-8");
    const backendSection = doc.slice(doc.indexOf("## Backend metrics"), doc.indexOf("## Gateway metrics"));
    const documented = new Set(
      [...backendSection.matchAll(/^\| `([a-z_:0-9]+)`/gm)].map((m) => m[1]),
    );
    const registered = new Set(registry.names());
    expect([...registered].filter((n) => !documented.has(n)), "registered but not documented").toEqual([]);
    expect([...documented].filter((n) => !registered.has(n)), "documented but not registered").toEqual([]);
  });
});

describe("label values are closed sets", () => {
  it("kindClass maps every kind to one of a fixed set of names", () => {
    const allowed = new Set([
      "profile", "note", "deletion", "reaction", "chat", "video", "gift_wrap", "report",
      "membership", "zap", "article", "music", "proposal", "group_metadata", "other",
    ]);
    const seen = new Set<string>();
    for (let kind = 0; kind <= 40_000; kind++) seen.add(kindClass(kind));
    for (const k of [-1, 65_535, 1e9, NaN]) seen.add(kindClass(k));
    expect([...seen].filter((c) => !allowed.has(c))).toEqual([]);
    expect(kindClass(9)).toBe("chat");
    expect(kindClass(1059)).toBe("gift_wrap");
    expect(kindClass(31683)).toBe("music");
    expect(kindClass(12345)).toBe("other");
  });

  it("methodLabel collapses unknown methods", () => {
    expect(methodLabel("GET")).toBe("GET");
    expect(methodLabel("PROPFIND")).toBe("OTHER");
    expect(methodLabel("get")).toBe("OTHER");
  });
});

describe("ingest event recording", () => {
  beforeEach(() => {
    ingestEventsTotal.reset();
    ingestHandlerErrors.reset();
    ingestLastEventCreatedAt.reset();
    ingestLastEventTimestamp.reset();
  });

  it("counts by kind class and source, and stamps the receive time", () => {
    const before = Date.now() / 1000;
    recordIngestedEvent(9, 1_700_000_000, true);
    recordIngestedEvent(9, 1_700_000_001, true);
    recordIngestedEvent(7, 1_700_000_002, false);
    expect(ingestEventsTotal.get({ kind_class: "chat", source: "own" })).toBe(2);
    expect(ingestEventsTotal.get({ kind_class: "reaction", source: "external" })).toBe(1);
    expect(ingestLastEventTimestamp.get({ source: "own" })).toBeGreaterThanOrEqual(before);
    expect(ingestLastEventTimestamp.get({ source: "external" })).toBeGreaterThanOrEqual(before);
  });

  it("the lag gauge follows the newest created_at from the own relay only", () => {
    recordIngestedEvent(1, 1_700_000_500, true);
    recordIngestedEvent(1, 1_700_000_100, true); // older: must not move it back
    expect(ingestLastEventCreatedAt.get()).toBe(1_700_000_500);
    recordIngestedEvent(9, 1_700_009_999, false); // external relay: ignored
    expect(ingestLastEventCreatedAt.get()).toBe(1_700_000_500);
  });

  it("gift wraps (backdated) and future-dated events cannot skew the lag gauge", () => {
    recordIngestedEvent(1, 1_700_000_500, true);
    recordIngestedEvent(1059, 1_700_000_900, true);
    expect(ingestLastEventCreatedAt.get()).toBe(1_700_000_500);

    const farFuture = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;
    recordIngestedEvent(1, farFuture, true);
    expect(ingestLastEventCreatedAt.get()).toBeLessThanOrEqual(Date.now() / 1000 + 1);
  });

  it("counts handler errors by kind class and stage", () => {
    recordIngestError(31683, "search_index");
    recordIngestError(31683, "search_index");
    recordIngestError(0, "process");
    expect(ingestHandlerErrors.get({ kind_class: "music", stage: "search_index" })).toBe(2);
    expect(ingestHandlerErrors.get({ kind_class: "profile", stage: "process" })).toBe(1);
  });
});

describe("runInstrumentedJob", () => {
  beforeEach(() => {
    jobRuns.reset();
    jobLastSuccess.reset();
    jobLastRunDuration.reset();
  });

  it("records a success with its timestamp and duration", async () => {
    const before = Date.now() / 1000;
    const result = await runInstrumentedJob("unit-job", async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 42;
    });
    expect(result).toBe(42);
    expect(jobRuns.get({ job: "unit-job", result: "success" })).toBe(1);
    expect(jobRuns.get({ job: "unit-job", result: "failure" })).toBe(0);
    expect(jobLastSuccess.get({ job: "unit-job" })).toBeGreaterThanOrEqual(before);
    expect(jobLastRunDuration.get({ job: "unit-job" })).toBeGreaterThanOrEqual(0.015);
  });

  it("records a thrown error as a failure, rethrows, and leaves last-success alone", async () => {
    await runInstrumentedJob("unit-job", () => {});
    const lastSuccess = jobLastSuccess.get({ job: "unit-job" });

    await expect(
      runInstrumentedJob("unit-job", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(jobRuns.get({ job: "unit-job", result: "failure" })).toBe(1);
    expect(jobLastSuccess.get({ job: "unit-job" })).toBe(lastSuccess);
  });

  // Most periodic computers catch their own errors so one bad pass cannot
  // kill the interval. Such a pass returns normally and must still not count
  // as a success: an alert on last-success age depends on it.
  it("a job that catches its own error and reports it is a failure, not a success", async () => {
    await runInstrumentedJob("swallowing-job", async () => {
      try {
        throw new Error("meilisearch unreachable");
      } catch {
        recordJobFailure("swallowing-job");
      }
    });
    expect(jobRuns.get({ job: "swallowing-job", result: "failure" })).toBe(1);
    expect(jobRuns.get({ job: "swallowing-job", result: "success" })).toBe(0);
    expect(jobLastSuccess.get({ job: "swallowing-job" })).toBeUndefined();

    // The next clean pass is a success again.
    await runInstrumentedJob("swallowing-job", async () => {});
    expect(jobRuns.get({ job: "swallowing-job", result: "success" })).toBe(1);
    expect(jobLastSuccess.get({ job: "swallowing-job" })).toBeGreaterThan(0);
  });

  it("a failure reported by another job does not taint this one", async () => {
    await runInstrumentedJob("job-a", async () => {
      recordJobFailure("job-b");
    });
    expect(jobRuns.get({ job: "job-a", result: "success" })).toBe(1);
  });
});
