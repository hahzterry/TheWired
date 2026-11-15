package metrics

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"strconv"
	"syscall"
	"time"
)

// Default is the registry the gateway's own metrics live in and the internal
// listener serves.
var Default = NewRegistry()

// Route groups: the gateway's own route tree, not backend route templates
// (those are the backend's to label). A closed set.
const (
	RouteAPI    = "api"    // /api/* → backend API
	RouteUpload = "upload" // PUT/HEAD /upload
	RouteList   = "list"   // /list/<pubkey>
	RouteHLS    = "hls"    // /hls/*
	RouteBlob   = "blob"   // /<sha256>[.ext] catch-all (and its 404s)
	RouteHealth = "health" // /health
)

// Upstream names for the two reverse proxies.
const (
	UpstreamAPI     = "api"
	UpstreamBlossom = "blossom"
)

var (
	httpRequests = Default.NewCounter(
		"gateway_http_requests_total",
		"Requests answered by the gateway, by route group, method and status code.",
		"route", "method", "status",
	)
	httpDuration = Default.NewHistogram(
		"gateway_http_request_duration_seconds",
		"Time from request received to response written, by route group and method.",
		DurationBuckets,
		"route", "method",
	)
	authFailures = Default.NewCounter(
		"gateway_auth_failures_total",
		"NIP-98 Authorization headers the gateway rejected, by reason.",
		"reason",
	)
	rateLimitRejections = Default.NewCounter(
		"gateway_rate_limit_rejections_total",
		"Requests answered 429, by the bucket that was exhausted.",
		"bucket",
	)
	rateLimitStoreErrors = Default.NewCounter(
		"gateway_rate_limit_store_errors_total",
		"Rate-limit or replay-guard checks that could not reach the store, by check and whether the request was let through (allowed) or refused (rejected).",
		"check", "outcome",
	)
	upstreamRequests = Default.NewCounter(
		"gateway_upstream_requests_total",
		"Requests forwarded to the backend, by upstream and the status class it answered with (error = no response).",
		"upstream", "status_class",
	)
	upstreamErrors = Default.NewCounter(
		"gateway_upstream_errors_total",
		"Forwarded requests the backend did not answer, by upstream and reason.",
		"upstream", "reason",
	)
	upstreamDuration = Default.NewHistogram(
		"gateway_upstream_request_duration_seconds",
		"Time until the backend's response headers arrived, by upstream.",
		DurationBuckets,
		"upstream",
	)
	blockedInternalPaths = Default.NewCounter(
		"gateway_internal_path_blocked_total",
		"Requests for an internal-only backend path (such as /api/metrics) refused at the gateway.",
	)
)

var knownMethods = map[string]bool{
	http.MethodGet: true, http.MethodHead: true, http.MethodPost: true, http.MethodPut: true,
	http.MethodPatch: true, http.MethodDelete: true, http.MethodOptions: true,
}

func methodLabel(m string) string {
	if knownMethods[m] {
		return m
	}
	return "OTHER"
}

// Auth failure reasons: every value AuthFailure is called with.
const (
	AuthInvalidScheme     = "invalid_scheme"
	AuthInvalidBase64     = "invalid_base64"
	AuthInvalidEventJSON  = "invalid_event_json"
	AuthWrongKind         = "wrong_kind"
	AuthStaleTimestamp    = "stale_timestamp"
	AuthURLMismatch       = "url_mismatch"
	AuthMethodMismatch    = "method_mismatch"
	AuthInvalidID         = "invalid_id"
	AuthInvalidSignature  = "invalid_signature"
	AuthPayloadMismatch   = "payload_mismatch"
	AuthPayloadRequired   = "payload_required"
	AuthReplay            = "replay"
	AuthReplayUnavailable = "replay_store_unavailable"
	AuthOther             = "other"
)

// AuthFailure counts a rejected Authorization header.
func AuthFailure(reason string) { authFailures.Inc(reason) }

// Rate-limit buckets.
const (
	BucketIP       = "ip"
	BucketReport   = "report"
	BucketAuthFail = "auth_fail"
	// plus the limiter categories: read, write, search, media
)

var knownBuckets = map[string]bool{
	"read": true, "write": true, "search": true, "media": true,
	BucketIP: true, BucketReport: true, BucketAuthFail: true,
}

func bucketLabel(b string) string {
	if knownBuckets[b] {
		return b
	}
	return "other"
}

// RateLimitRejection counts a 429.
func RateLimitRejection(bucket string) { rateLimitRejections.Inc(bucketLabel(bucket)) }

// RateLimitStoreError counts a limiter / replay-guard check that could not
// reach its store. `check` is a bucket name or "replay".
func RateLimitStoreError(check string, allowed bool) {
	outcome := "rejected"
	if allowed {
		outcome = "allowed"
	}
	if check != "replay" {
		check = bucketLabel(check)
	}
	rateLimitStoreErrors.Inc(check, outcome)
}

// InternalPathBlocked counts a refused request for an internal-only path.
func InternalPathBlocked() { blockedInternalPaths.Inc() }

// ── request middleware ──────────────────────────────────────────────────────

type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (s *statusWriter) WriteHeader(code int) {
	if !s.wrote {
		s.status = code
		s.wrote = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	s.wrote = true
	return s.ResponseWriter.Write(b)
}

// Flush keeps streamed proxy responses (blobs, HLS) flushing through.
func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// Instrument counts and times every request through next under one route
// group. The request path is never a label.
func Instrument(route string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		defer func() {
			method := methodLabel(r.Method)
			httpRequests.Inc(route, method, strconv.Itoa(sw.status))
			httpDuration.Observe(time.Since(start).Seconds(), route, method)
		}()
		next.ServeHTTP(sw, r)
	})
}

// ── upstream transport ──────────────────────────────────────────────────────

type instrumentedTransport struct {
	upstream string
	next     http.RoundTripper
}

// InstrumentTransport wraps a backend transport: it times each round trip (to
// response headers) and classifies the outcome.
func InstrumentTransport(upstream string, next http.RoundTripper) http.RoundTripper {
	return &instrumentedTransport{upstream: upstream, next: next}
}

func (t *instrumentedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	start := time.Now()
	resp, err := t.next.RoundTrip(req)
	upstreamDuration.Observe(time.Since(start).Seconds(), t.upstream)
	if err != nil {
		upstreamRequests.Inc(t.upstream, "error")
		upstreamErrors.Inc(t.upstream, upstreamErrorReason(err))
		return resp, err
	}
	upstreamRequests.Inc(t.upstream, statusClass(resp.StatusCode))
	return resp, nil
}

func statusClass(code int) string {
	switch {
	case code >= 500:
		return "5xx"
	case code >= 400:
		return "4xx"
	case code >= 300:
		return "3xx"
	case code >= 200:
		return "2xx"
	}
	return "1xx"
}

// upstreamErrorReason maps a transport error to a closed set of reasons. The
// error text (which names the backend address) never becomes a label.
func upstreamErrorReason(err error) string {
	if errors.Is(err, context.Canceled) {
		return "client_canceled" // the caller went away mid-request
	}
	if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) {
		return "timeout"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "timeout"
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return "connection_refused"
	}
	if errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) {
		return "connection_reset"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "dns"
	}
	return "other"
}
