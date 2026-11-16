# Metrics

The backend and the gateway each export Prometheus metrics. This page lists
every metric, explains how the endpoints are kept off the public paths, and
gives example alert rules.

The relay has its own plain-text counters at `/metrics` on its main port
(`services/relay/src/server.rs`); they are not covered here.

## Where the metrics are served

Both services serve metrics from a **separate listener**, not from the port
that takes client traffic:

| Service | Variable | Example | Default |
|---------|----------|---------|---------|
| Backend | `METRICS_ADDR` | `127.0.0.1:9464` | unset: no listener |
| Gateway | `METRICS_ADDR` | `127.0.0.1:9091` | unset: no listener |

`METRICS_ADDR` takes `host:port`, `[v6]:port`, `:port` or a bare port. With no
host the listener binds to loopback. Give a host (for example `0.0.0.0`) only
when the scraper runs somewhere else and the port is on a private network. A
malformed value stops the service at boot rather than silently exporting
nothing. If the address is valid but cannot be bound (the port is taken), the
service logs the error and keeps serving without metrics; the `up == 0` alert
at the end of this page is what catches that.

The listener answers `GET /metrics` and `HEAD /metrics`. Every other path is a
404 and every other method a 405; it is not a second way into the API.

The backend also has `METRICS_SAMPLE_INTERVAL_MS` (default `15000`): how often
the dependency probes and queue-depth gauges are refreshed. A scrape only reads
memory; it never waits on a dependency.

### Why a separate listener

The gateway forwards `/api/<path>` to the backend as `/<path>`, and the web
proxy forwards a set of paths straight to the backend. Anything the backend
serves on its API port is therefore one routing rule away from the internet.
Metrics name internal routes, dependency state and traffic volume, so they are
kept off that port entirely:

1. **Backend**: the API server has no `/metrics` route. `GET /metrics` on the
   API port is an ordinary 404.
2. **Gateway**: the public handler has no `/metrics` route either, and it
   refuses `/api/metrics` (and anything under it, in any spelling) with a 404
   before authentication, rate limiting or the proxy run. This is a second
   lock: it holds even if a metrics route were ever mounted on the backend's
   API port.
3. **Web proxy**: `services/proxy/Caddyfile` answers 404 for `/metrics` and
   `/api/metrics` on the API hostname before the request reaches the gateway.
4. The gateway refuses to start if `METRICS_ADDR` names its public port.

Never publish the metrics ports, and never add a proxy route to them.

### Labels

Label values come from closed sets defined in code: route templates, status
codes, dependency names, kind classes, job names, failure reasons. Pubkeys,
event ids, relay URLs, space ids, IP addresses and raw request paths are never
labels. A request that matches no route is labelled `unmatched`, whatever path
it asked for.

As a backstop, each metric holds a bounded number of label combinations.
Observations for a new combination past the cap are dropped and counted in
`backend_metrics_dropped_series` / `gateway_metrics_dropped_series`. Those
should always be 0; a non-zero value means a label has become unbounded.

## Backend metrics

### HTTP

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `backend_http_requests_total` | counter | `method`, `route`, `status` | Requests answered. `route` is the route template (`/spaces/:id`), or `unmatched`. |
| `backend_http_request_duration_seconds` | histogram | `method`, `route` | Time from request received to response sent. |

### Process

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `process_cpu_user_seconds_total` | counter | | User CPU time. |
| `process_cpu_system_seconds_total` | counter | | System CPU time. |
| `process_cpu_seconds_total` | counter | | User plus system CPU time. |
| `process_start_time_seconds` | gauge | | Unix time the process started. A change means a restart. |
| `process_resident_memory_bytes` | gauge | | Resident memory. |
| `nodejs_heap_size_total_bytes` | gauge | | V8 heap size. |
| `nodejs_heap_size_used_bytes` | gauge | | V8 heap in use. |
| `nodejs_external_memory_bytes` | gauge | | Memory held by native objects. |
| `nodejs_eventloop_lag_mean_seconds` | gauge | | Mean event-loop delay over the last completed 10 s window. |
| `nodejs_eventloop_lag_p99_seconds` | gauge | | 99th percentile event-loop delay over the last completed 10 s window. |
| `nodejs_eventloop_lag_max_seconds` | gauge | | Largest event-loop delay over the last completed 10 s window. |
| `nodejs_version_info` | gauge | `version` | Constant 1, labelled with the Node.js version. |

Event-loop delay is measured in fixed 10 s windows that the process closes
itself, and a scrape reads the last closed window. Scraping does not reset
anything, so several scrapers (or a manual `curl`) all see the same values.
The values are the delay itself, with the 20 ms sampling interval taken out,
so an idle process reads close to 0. It is measured only while the metrics
listener is running.

### Dependencies

`dependency` is `postgres`, `redis` or `meilisearch`. A sampler probes each
one every `METRICS_SAMPLE_INTERVAL_MS` and is the only thing that writes
these metrics. It runs only when `METRICS_ADDR` is set.

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `backend_dependency_up` | gauge | `dependency` | 1 if the last probe succeeded, 0 if it failed or timed out (2 s budget). |
| `backend_dependency_last_success_timestamp_seconds` | gauge | `dependency` | Unix time of the last successful probe. 0 means never since the process started. |
| `backend_dependency_last_check_timestamp_seconds` | gauge | `dependency` | Unix time of the last probe, successful or not. If this stops moving, the sampler has stopped. |
| `backend_dependency_check_duration_seconds` | gauge | `dependency` | How long the last probe took. |
| `backend_dependency_check_failures_total` | counter | `dependency` | Probes that failed or timed out. |

`GET /health` runs the same three probes and answers 503 when any of them is
down, but it only reports: calling it does not change these metrics, so
nobody outside can move the gauges or inflate the failure counter.

A probe that does not answer within its budget is reported as down, and no
new probe of that dependency is started until the pending one settles. A
dependency that has stopped answering therefore holds one pending probe, not
one more every interval. The queue samples below work the same way.

### Relay ingestion: connections

`scope` is `own` (the platform relay) or `external` (registered space relays).

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `backend_ingest_relays_configured` | gauge | `scope` | Relays the ingester is meant to hold a connection to. |
| `backend_ingest_relays_connected` | gauge | `scope` | Relays it currently has an open socket to. |
| `backend_ingest_relay_connects_total` | counter | `scope` | Sockets that reached the open state. |
| `backend_ingest_relay_reconnects_total` | counter | `scope` | Reconnects scheduled after a socket closed, errored or was refused. |
| `backend_ingest_own_relay_authenticated` | gauge | | 1 while the platform-relay socket has completed NIP-42 AUTH with the ingest key. Stays 0 when no ingest key is configured. |

### Relay ingestion: events

`kind_class` is one of `profile`, `note`, `deletion`, `reaction`, `chat`,
`video`, `gift_wrap`, `report`, `membership`, `zap`, `article`, `music`,
`proposal`, `group_metadata`, `other`. `source` is `own` or `external`.

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `backend_ingest_events_total` | counter | `kind_class`, `source` | Verified events the ingester processed. |
| `backend_ingest_events_rejected_total` | counter | `reason` | Events refused before processing: `invalid_signature`, `author_blocked`. |
| `backend_ingest_handler_errors_total` | counter | `kind_class`, `stage` | Errors while processing an event. `stage` is `process`, `search_index`, `revision`, `proposal`, `deletion` or `notifications`. |
| `backend_ingest_last_event_timestamp_seconds` | gauge | `source` | Unix time the ingester last processed an event. |
| `backend_ingest_last_event_created_at_seconds` | gauge | | Newest `created_at` seen from the platform relay. `time()` minus this is the ingest lag. Gift wraps are excluded because their timestamps are backdated. |

### Notifications

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `backend_notification_queue_depth` | gauge | | Rows in the push queue not yet sent or retired. Read from the table, so it stays true when the dispatcher has stopped. |
| `backend_notification_queue_oldest_age_seconds` | gauge | | Age of the oldest unsent row. 0 when the queue is empty. |
| `backend_notification_pushes_sent_total` | counter | `channel` | Pushes a push service accepted. `channel` is `webpush` or `expo`. |
| `backend_notification_send_failures_total` | counter | `channel`, `reason` | Pushes refused or failed. `reason` is `subscription_gone`, `send_error`, `device_not_registered`, `ticket_error`, `request_failed`, `receipt_error` or `receipts_request_failed`. |
| `backend_notification_rows_total` | counter | `outcome` | Queue rows a dispatcher pass settled: `sent`, `expired`, `deferred`, `retried`. |

### Transcoding

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `backend_transcode_jobs_total` | counter | `result` | Transcode jobs this process finished: `completed`, `failed`. |
| `backend_transcode_job_duration_seconds` | histogram | `result` | Wall time of a transcode job. |
| `backend_transcode_jobs_active` | gauge | | Transcode jobs running in this process. |
| `backend_transcode_queue_jobs` | gauge | `state` | Jobs in the transcode queue: `waiting`, `active`, `delayed`, `failed`. Only sampled when transcoding is enabled. |

### Periodic jobs

`job` is the job's lock name: `trendingComputer`, `profileRefresher`,
`profileStatsComputer`, `analyticsDailyAggregation`, `analyticsRollingStats`,
`discoveryScoreComputer`, `notificationDispatcher`, `expoReceiptPoller`,
`accountDeletionWorker`.

Each job runs on at most one replica per tick, so with several replicas take
`max` across instances before comparing a timestamp to `time()`.

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `backend_job_runs_total` | counter | `job`, `result` | Runs in this process: `success`, `failure`. A job that catches its own error still counts as a failure. |
| `backend_job_last_success_timestamp_seconds` | gauge | `job` | Unix time the job last finished without error in this process. |
| `backend_job_last_run_duration_seconds` | gauge | `job` | How long the last run took. |
| `backend_job_lock_skips_total` | counter | `job` | Scheduled ticks skipped because another replica or pass held the job's lock. The dispatcher's extra on-demand passes are not counted when they lose the lock. |

### Registry

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `backend_metrics_dropped_series` | gauge | | Observations dropped at a metric's series cap. Should be 0. |

## Gateway metrics

`route` is the gateway's own route group, not a backend route template: `api`
(`/api/*`), `upload`, `list`, `hls`, `blob` (the `/<sha256>` catch-all and its
404s) or `health`. `upstream` is `api` or `blossom`, the two reverse proxies.

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `gateway_http_requests_total` | counter | `route`, `method`, `status` | Requests answered by the gateway. |
| `gateway_http_request_duration_seconds` | histogram | `route`, `method` | Time from request received to response written. |
| `gateway_auth_failures_total` | counter | `reason` | NIP-98 `Authorization` headers rejected. `reason` is `invalid_scheme`, `invalid_base64`, `invalid_event_json`, `wrong_kind`, `stale_timestamp`, `url_mismatch`, `method_mismatch`, `invalid_id`, `invalid_signature`, `payload_mismatch`, `payload_required`, `replay`, `replay_store_unavailable` or `other`. |
| `gateway_rate_limit_rejections_total` | counter | `bucket` | Requests answered 429. `bucket` is `ip`, `read`, `write`, `search`, `media`, `report` or `auth_fail`. |
| `gateway_rate_limit_store_errors_total` | counter | `check`, `outcome` | Rate-limit or replay checks that could not reach Redis. `check` is a bucket name or `replay`; `outcome` is `allowed` (failed open) or `rejected` (failed closed). |
| `gateway_upstream_requests_total` | counter | `upstream`, `status_class` | Requests forwarded to the backend, by the class it answered with: `2xx`, `3xx`, `4xx`, `5xx`, or `error` when it did not answer. |
| `gateway_upstream_errors_total` | counter | `upstream`, `reason` | Forwarded requests the backend did not answer: `connection_refused`, `connection_reset`, `timeout`, `dns`, `client_canceled`, `other`. |
| `gateway_upstream_request_duration_seconds` | histogram | `upstream` | Time until the backend's response headers arrived. |
| `gateway_internal_path_blocked_total` | counter | | Requests for an internal-only backend path (`/api/metrics`) refused at the gateway. |
| `go_goroutines` | gauge | | Goroutines that currently exist. |
| `go_memstats_heap_alloc_bytes` | gauge | | Heap bytes in use. |
| `go_memstats_sys_bytes` | gauge | | Memory obtained from the OS. |
| `go_gc_cycles_total` | counter | | Completed GC cycles. |
| `process_start_time_seconds` | gauge | | Unix time the process started. |
| `process_cpu_seconds_total` | counter | | User plus system CPU time. |
| `gateway_metrics_dropped_series` | gauge | | Observations dropped at a metric's series cap. Should be 0. |

A client that disconnects while its request is being proxied shows up as
`gateway_upstream_errors_total{reason="client_canceled"}` and as a 502 in
`gateway_http_requests_total`, although nobody received that 502. The example
upstream alert below leaves `client_canceled` out for that reason.

## Example scrape configuration

Host names and ports here are placeholders. Use whatever `METRICS_ADDR` you
set, reachable only from the scraper.

```yaml
scrape_configs:
  - job_name: backend
    scrape_interval: 15s
    static_configs:
      - targets: ["backend.internal:9464"]
  - job_name: gateway
    scrape_interval: 15s
    static_configs:
      - targets: ["gateway.internal:9091"]
```

## Example alert rules

These are starting points. Tune the thresholds and `for` durations to your
traffic.

```yaml
groups:
  - name: backend
    rules:
      # A dependency the backend cannot reach. Search, browse and trending
      # depend on Meilisearch; this is the alert for a search engine that is
      # down or crash-looping.
      - alert: MeilisearchDown
        expr: max(backend_dependency_up{dependency="meilisearch"}) == 0
        for: 5m
        labels:
          severity: page
        annotations:
          summary: The backend has not reached Meilisearch for 5 minutes.

      # The same failure seen from the other side: no successful probe in ten
      # minutes. This also fires for a dependency that flaps too fast for the
      # rule above, or that has been down since the backend started (the
      # timestamp is then 0).
      - alert: DependencyNoRecentSuccess
        expr: time() - max by (dependency) (backend_dependency_last_success_timestamp_seconds) > 600
        for: 1m
        labels:
          severity: page
        annotations:
          summary: "No successful {{ $labels.dependency }} probe for 10 minutes."

      - alert: PostgresOrRedisDown
        expr: max by (dependency) (backend_dependency_up{dependency=~"postgres|redis"}) == 0
        for: 2m
        labels:
          severity: page
        annotations:
          summary: "The backend cannot reach {{ $labels.dependency }}."

      # The ingester has no socket to the platform relay. Nothing is indexed
      # and no push is planned while this holds.
      - alert: IngestRelayDisconnected
        expr: max(backend_ingest_relays_connected{scope="own"}) < 1
        for: 5m
        labels:
          severity: page
        annotations:
          summary: The backend ingester is not connected to the platform relay.

      # Connected, but nothing has arrived for half an hour. On a busy relay
      # that means the subscription is dead. On a quiet one it can be normal:
      # raise the threshold, or drop this rule and rely on the two above.
      - alert: IngestStalled
        expr: |
          time() - max(backend_ingest_last_event_timestamp_seconds{source="own"}) > 1800
          and on() max(backend_ingest_relays_connected{scope="own"}) >= 1
        for: 10m
        labels:
          severity: warn
        annotations:
          summary: The ingester is connected but has processed no event for 30 minutes.

      # Some registered space relays are unreachable.
      - alert: IngestRelayConnectionsDropped
        expr: |
          sum(backend_ingest_relays_configured{scope="external"})
            - sum(backend_ingest_relays_connected{scope="external"}) > 0
        for: 15m
        labels:
          severity: warn
        annotations:
          summary: "{{ $value }} registered relay(s) have had no ingest connection for 15 minutes."

      # A socket that keeps dropping and reconnecting.
      - alert: IngestRelayFlapping
        expr: sum by (scope) (increase(backend_ingest_relay_reconnects_total[15m])) > 10
        for: 5m
        labels:
          severity: warn
        annotations:
          summary: "Ingest connections ({{ $labels.scope }}) reconnected more than 10 times in 15 minutes."

      - alert: IngestHandlerErrors
        expr: sum by (stage) (rate(backend_ingest_handler_errors_total[10m])) > 0.1
        for: 10m
        labels:
          severity: warn
        annotations:
          summary: "Ingested events are failing at the {{ $labels.stage }} stage."

      - alert: BackendHigh5xxRate
        expr: |
          sum(rate(backend_http_requests_total{status=~"5.."}[5m]))
            / sum(rate(backend_http_requests_total[5m])) > 0.05
        for: 5m
        labels:
          severity: page
        annotations:
          summary: More than 5% of backend responses are 5xx.

      - alert: BackendSlowRequests
        expr: |
          histogram_quantile(0.95,
            sum by (le) (rate(backend_http_request_duration_seconds_bucket[5m]))) > 2
        for: 10m
        labels:
          severity: warn
        annotations:
          summary: Backend p95 latency is above 2 seconds.

      # The dispatcher polls every 30 seconds and retires rows after 15
      # minutes, so a backlog that is both large and old means pushes are not
      # going out.
      - alert: NotificationQueueGrowing
        expr: |
          max(backend_notification_queue_depth) > 100
          and max(backend_notification_queue_oldest_age_seconds) > 300
        for: 10m
        labels:
          severity: warn
        annotations:
          summary: "{{ $value }} pushes are waiting and the oldest is over 5 minutes old."

      - alert: NotificationSendFailures
        expr: |
          sum(rate(backend_notification_send_failures_total{reason=~"request_failed|send_error|ticket_error"}[15m]))
            > sum(rate(backend_notification_pushes_sent_total[15m]))
        for: 15m
        labels:
          severity: warn
        annotations:
          summary: More pushes are failing than succeeding.

      # A periodic job has not finished cleanly in three of its intervals
      # (30 minutes each for these two). `max` because only one replica runs
      # a given tick.
      - alert: PeriodicJobStale
        expr: |
          time() - max by (job) (
            backend_job_last_success_timestamp_seconds{job=~"trendingComputer|profileStatsComputer"}
          ) > 5400
        for: 5m
        labels:
          severity: warn
        annotations:
          summary: "{{ $labels.job }} has not completed successfully for 90 minutes."

      - alert: TranscodeBacklog
        expr: max(backend_transcode_queue_jobs{state="waiting"}) > 20
        for: 30m
        labels:
          severity: warn
        annotations:
          summary: "{{ $value }} transcode jobs have been waiting for 30 minutes."

      - alert: BackendEventLoopBlocked
        expr: max(nodejs_eventloop_lag_p99_seconds) > 0.5
        for: 10m
        labels:
          severity: warn
        annotations:
          summary: Backend event-loop p99 delay is above 500 ms.

      - alert: MetricLabelUnbounded
        expr: max(backend_metrics_dropped_series) > 0 or max(gateway_metrics_dropped_series) > 0
        for: 1m
        labels:
          severity: warn
        annotations:
          summary: A metric hit its series cap. A label value is unbounded.

  - name: gateway
    rules:
      - alert: GatewayHigh5xxRate
        expr: |
          sum(rate(gateway_http_requests_total{status=~"5.."}[5m]))
            / sum(rate(gateway_http_requests_total[5m])) > 0.05
        for: 5m
        labels:
          severity: page
        annotations:
          summary: More than 5% of gateway responses are 5xx.

      # The gateway cannot reach the backend at all.
      - alert: GatewayUpstreamUnreachable
        expr: |
          sum(rate(gateway_upstream_errors_total{reason=~"connection_refused|timeout|dns"}[5m])) > 0.1
        for: 5m
        labels:
          severity: page
        annotations:
          summary: The gateway is failing to reach the backend.

      - alert: GatewayUpstreamSlow
        expr: |
          histogram_quantile(0.95,
            sum by (le) (rate(gateway_upstream_request_duration_seconds_bucket{upstream="api"}[5m]))) > 2
        for: 10m
        labels:
          severity: warn
        annotations:
          summary: Backend p95 time-to-first-byte, seen from the gateway, is above 2 seconds.

      # Redis is unreachable from the gateway: rate limits and the replay
      # guard are failing open or closed, depending on configuration.
      - alert: GatewayRateLimitStoreDown
        expr: sum(rate(gateway_rate_limit_store_errors_total[5m])) > 0
        for: 5m
        labels:
          severity: page
        annotations:
          summary: The gateway cannot reach its rate-limit store.

      - alert: GatewayAuthFailureSpike
        expr: sum(rate(gateway_auth_failures_total[5m])) > 5
        for: 10m
        labels:
          severity: warn
        annotations:
          summary: NIP-98 verification is failing more than 5 times a second.

      - alert: GatewayRateLimiting
        expr: sum by (bucket) (rate(gateway_rate_limit_rejections_total[5m])) > 5
        for: 10m
        labels:
          severity: warn
        annotations:
          summary: "The {{ $labels.bucket }} rate limit is rejecting more than 5 requests a second."

  - name: scrape
    rules:
      # Nothing above can fire if the service is not being scraped.
      - alert: MetricsTargetDown
        expr: up{job=~"backend|gateway"} == 0
        for: 5m
        labels:
          severity: page
        annotations:
          summary: "Prometheus cannot scrape {{ $labels.job }}."
```
