/**
 * Every metric the backend exports, in one place (docs/METRICS.md lists them
 * with example alerts). Served by the internal listener in metricsServer.ts —
 * never by the API server, so no public path can reach them.
 *
 * Label rule: values come from closed sets defined here (route templates,
 * dependency names, kind classes, job names). No pubkeys, event ids, relay
 * URLs, space ids or raw request paths.
 */
import { Registry } from "./registry.js";
import { registerProcessMetrics } from "./process.js";

export { METRICS_CONTENT_TYPE } from "./registry.js";

export const registry = new Registry();

/** Event-loop delay measurement; started by the metrics listener, off until
 *  then (see process.ts). */
export const eventLoopMonitor = registerProcessMetrics(registry);

// ── HTTP ────────────────────────────────────────────────────────────────────

export const httpRequestsTotal = registry.counter({
  name: "backend_http_requests_total",
  help: "HTTP requests answered, by method, route template and status code.",
  labelNames: ["method", "route", "status"] as const,
});

export const httpRequestDuration = registry.histogram({
  name: "backend_http_request_duration_seconds",
  help: "Time from request received to response sent, by method and route template.",
  labelNames: ["method", "route"] as const,
});

const KNOWN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export function methodLabel(method: string): string {
  return KNOWN_METHODS.has(method) ? method : "OTHER";
}

/** The label for a request that matched no route: every unknown path shares
 *  it, so a scanner cannot mint series. */
export const UNMATCHED_ROUTE = "unmatched";

// ── Dependencies ────────────────────────────────────────────────────────────

export const DEPENDENCIES = ["postgres", "redis", "meilisearch"] as const;
export type Dependency = (typeof DEPENDENCIES)[number];

export const dependencyUp = registry.gauge({
  name: "backend_dependency_up",
  help: "1 if the last probe of the dependency succeeded, 0 if it failed or timed out.",
  labelNames: ["dependency"] as const,
});

export const dependencyLastSuccess = registry.gauge({
  name: "backend_dependency_last_success_timestamp_seconds",
  help: "Unix time of the last successful probe of the dependency (0 = never since start).",
  labelNames: ["dependency"] as const,
});

export const dependencyLastCheck = registry.gauge({
  name: "backend_dependency_last_check_timestamp_seconds",
  help: "Unix time of the last probe of the dependency, successful or not.",
  labelNames: ["dependency"] as const,
});

export const dependencyCheckDuration = registry.gauge({
  name: "backend_dependency_check_duration_seconds",
  help: "How long the last probe of the dependency took.",
  labelNames: ["dependency"] as const,
});

export const dependencyCheckFailures = registry.counter({
  name: "backend_dependency_check_failures_total",
  help: "Probes of the dependency that failed or timed out.",
  labelNames: ["dependency"] as const,
});

// ── Relay ingestion: connections ────────────────────────────────────────────

/** `own` = the platform relay, `external` = registered space relays. */
export type RelayScope = "own" | "external";

export const ingestRelaysConfigured = registry.gauge({
  name: "backend_ingest_relays_configured",
  help: "Relays the ingester is meant to hold a connection to.",
  labelNames: ["scope"] as const,
});

export const ingestRelaysConnected = registry.gauge({
  name: "backend_ingest_relays_connected",
  help: "Relays the ingester currently has an open socket to.",
  labelNames: ["scope"] as const,
});

export const ingestRelayConnects = registry.counter({
  name: "backend_ingest_relay_connects_total",
  help: "Ingester sockets that reached the open state.",
  labelNames: ["scope"] as const,
});

export const ingestRelayReconnects = registry.counter({
  name: "backend_ingest_relay_reconnects_total",
  help: "Reconnects the ingester scheduled after a socket closed, errored or was refused.",
  labelNames: ["scope"] as const,
});

export const ingestOwnRelayAuthenticated = registry.gauge({
  name: "backend_ingest_own_relay_authenticated",
  help: "1 while the socket to the platform relay has completed NIP-42 AUTH with the ingest key.",
});

// ── Relay ingestion: events ─────────────────────────────────────────────────

/** A closed set of names for the event kinds the ingester handles; every
 *  other kind is `other`. */
export function kindClass(kind: number): string {
  switch (kind) {
    case 0:
      return "profile";
    case 1:
      return "note";
    case 5:
      return "deletion";
    case 7:
      return "reaction";
    case 9:
      return "chat";
    case 22:
    case 34236:
      return "video";
    case 1059:
      return "gift_wrap";
    case 1984:
      return "report";
    case 9021:
    case 9022:
      return "membership";
    case 9735:
      return "zap";
    case 30023:
      return "article";
    case 30119:
    case 31683:
    case 33123:
      return "music";
    case 31685:
      return "proposal";
    case 39000:
    case 39002:
      return "group_metadata";
    default:
      return "other";
  }
}

export const ingestEventsTotal = registry.counter({
  name: "backend_ingest_events_total",
  help: "Verified events the ingester processed, by kind class and source relay scope.",
  labelNames: ["kind_class", "source"] as const,
});

export const ingestEventsRejected = registry.counter({
  name: "backend_ingest_events_rejected_total",
  help: "Events the ingester refused before processing (invalid_signature, author_blocked).",
  labelNames: ["reason"] as const,
});

export const ingestHandlerErrors = registry.counter({
  name: "backend_ingest_handler_errors_total",
  help: "Errors while processing an ingested event, by kind class and the stage that failed.",
  labelNames: ["kind_class", "stage"] as const,
});

export const ingestLastEventTimestamp = registry.gauge({
  name: "backend_ingest_last_event_timestamp_seconds",
  help: "Unix time the ingester last processed an event, by source relay scope.",
  labelNames: ["source"] as const,
});

export const ingestLastEventCreatedAt = registry.gauge({
  name: "backend_ingest_last_event_created_at_seconds",
  help: "Newest created_at seen from the platform relay (gift wraps excluded: they are backdated). time() minus this is the ingest lag.",
});

export type IngestErrorStage = "process" | "search_index" | "revision" | "proposal" | "deletion" | "notifications";

/** Count an ingested event and move the freshness gauges. */
export function recordIngestedEvent(kind: number, createdAt: number, isOwnRelay: boolean): void {
  const source: RelayScope = isOwnRelay ? "own" : "external";
  const nowSec = Date.now() / 1000;
  ingestEventsTotal.inc({ kind_class: kindClass(kind), source });
  ingestLastEventTimestamp.set({ source }, nowSec);
  // Gift wraps randomize created_at up to two days back; a client clock can
  // run ahead. Neither may move the lag gauge.
  if (isOwnRelay && kind !== 1059) {
    const seen = Math.min(createdAt, nowSec);
    if (seen > (ingestLastEventCreatedAt.get() ?? 0)) ingestLastEventCreatedAt.set(seen);
  }
}

export function recordIngestError(kind: number, stage: IngestErrorStage): void {
  ingestHandlerErrors.inc({ kind_class: kindClass(kind), stage });
}

// ── Notifications ───────────────────────────────────────────────────────────

export const notificationQueueDepth = registry.gauge({
  name: "backend_notification_queue_depth",
  help: "Rows in the push queue not yet sent or retired.",
});

export const notificationQueueOldestAge = registry.gauge({
  name: "backend_notification_queue_oldest_age_seconds",
  help: "Age of the oldest unsent row in the push queue (0 when the queue is empty).",
});

export const notificationPushesSent = registry.counter({
  name: "backend_notification_pushes_sent_total",
  help: "Pushes a push service accepted, by channel (webpush, expo).",
  labelNames: ["channel"] as const,
});

export type PushChannel = "webpush" | "expo";
export type PushFailureReason =
  | "subscription_gone"
  | "send_error"
  | "device_not_registered"
  | "ticket_error"
  | "request_failed"
  | "receipt_error"
  | "receipts_request_failed";

export const notificationSendFailures = registry.counter({
  name: "backend_notification_send_failures_total",
  help: "Pushes that were refused or failed, by channel and reason.",
  labelNames: ["channel", "reason"] as const,
});

export const notificationRows = registry.counter({
  name: "backend_notification_rows_total",
  help: "Queue rows a dispatcher pass settled, by outcome (sent, expired, deferred, retried).",
  labelNames: ["outcome"] as const,
});

// ── Transcoding ─────────────────────────────────────────────────────────────

export const transcodeJobs = registry.counter({
  name: "backend_transcode_jobs_total",
  help: "Transcode jobs this process finished, by result (completed, failed).",
  labelNames: ["result"] as const,
});

export const transcodeJobDuration = registry.histogram({
  name: "backend_transcode_job_duration_seconds",
  help: "Wall time of a transcode job, by result.",
  labelNames: ["result"] as const,
  buckets: [1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800],
});

export const transcodeJobsActive = registry.gauge({
  name: "backend_transcode_jobs_active",
  help: "Transcode jobs running in this process right now.",
});

export const TRANSCODE_QUEUE_STATES = ["waiting", "active", "delayed", "failed"] as const;

export const transcodeQueueJobs = registry.gauge({
  name: "backend_transcode_queue_jobs",
  help: "Jobs in the transcode queue, by state. Only sampled when transcoding is enabled.",
  labelNames: ["state"] as const,
});

// ── Periodic jobs ───────────────────────────────────────────────────────────

export const jobRuns = registry.counter({
  name: "backend_job_runs_total",
  help: "Runs of a periodic background job in this process, by result (success, failure).",
  labelNames: ["job", "result"] as const,
});

export const jobLastSuccess = registry.gauge({
  name: "backend_job_last_success_timestamp_seconds",
  help: "Unix time a periodic background job last finished without error in this process.",
  labelNames: ["job"] as const,
});

export const jobLastRunDuration = registry.gauge({
  name: "backend_job_last_run_duration_seconds",
  help: "How long the last run of a periodic background job took.",
  labelNames: ["job"] as const,
});

export const jobLockSkips = registry.counter({
  name: "backend_job_lock_skips_total",
  help: "Scheduled ticks of a periodic job skipped because another replica (or pass) held its lock.",
  labelNames: ["job"] as const,
});

/** Failures reported from inside a job that catches its own errors (most of
 *  the periodic computers log and swallow so one bad pass cannot kill the
 *  interval). The run wrapper reads this to tell a clean pass from a caught
 *  one. */
const reportedFailures = new Map<string, number>();

/** Call from a job's own catch block: the current run is not a success. */
export function recordJobFailure(job: string): void {
  reportedFailures.set(job, (reportedFailures.get(job) ?? 0) + 1);
}

/** Run one pass of a periodic job, recording its result and duration. An
 *  error is recorded and rethrown. */
export async function runInstrumentedJob<T>(job: string, task: () => Promise<T> | T): Promise<T> {
  const failuresBefore = reportedFailures.get(job) ?? 0;
  const startedAt = performance.now();
  const finish = (ok: boolean) => {
    jobLastRunDuration.set({ job }, (performance.now() - startedAt) / 1000);
    jobRuns.inc({ job, result: ok ? "success" : "failure" });
    if (ok) jobLastSuccess.set({ job }, Date.now() / 1000);
  };
  try {
    const result = await task();
    finish((reportedFailures.get(job) ?? 0) === failuresBefore);
    return result;
  } catch (err) {
    finish(false);
    throw err;
  }
}

// ── Registry health ─────────────────────────────────────────────────────────

const droppedSeries = registry.gauge({
  name: "backend_metrics_dropped_series",
  help: "Observations dropped because a metric reached its series cap. Non-zero means a label is unbounded.",
});
registry.onCollect(() => droppedSeries.set(registry.droppedSeries()));
