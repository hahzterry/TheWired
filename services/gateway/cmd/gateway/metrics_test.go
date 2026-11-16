package main

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/thewired/gateway/internal/config"
	"github.com/thewired/gateway/internal/metrics"
)

func metricValue(name string, labels ...string) float64 {
	return metrics.Default.Value(name, labels...)
}

func dump() string {
	var b strings.Builder
	metrics.Default.Write(&b)
	return b.String()
}

// The backend's metrics must not be reachable through the public API path:
// /api/<x> is forwarded to the backend as /<x>, so /api/metrics is refused at
// the gateway and the backend is never dialled — in every spelling.
func TestServer_APIMetricsNeverReachesBackend(t *testing.T) {
	var backendHits atomic.Int64
	h, _ := newTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backendHits.Add(1)
		// What a backend that DID serve metrics on its API port would answer.
		w.Write([]byte("backend_http_requests_total 1\n"))
	}), nil)

	targets := []string{
		"/api/metrics",
		"/api/metrics/",
		"/api/metrics?format=text",
		"/api/metrics/anything",
		"/api/METRICS",
		"/api/Metrics",
		"/api/%6Detrics",   // percent-encoded "m"
		"/api/%6d%65trics", // more of it
		"/api/metrics%2F",  // encoded trailing slash
		"/api/./metrics",
		"/api//metrics",
		"/api/spaces/../metrics",
		"/api/spaces/%2e%2e/metrics",
	}
	for _, method := range []string{"GET", "HEAD", "POST"} {
		for _, target := range targets {
			before := metricValue("gateway_internal_path_blocked_total")
			hitsBefore := backendHits.Load()

			// Follow the mux's own path-cleaning redirects, as a client would.
			rr := serveFollowingRedirects(t, h, method, target)

			if backendHits.Load() != hitsBefore {
				t.Errorf("%s %s reached the backend", method, target)
			}
			if rr.Code == http.StatusOK {
				t.Errorf("%s %s answered 200", method, target)
			}
			if strings.Contains(rr.Body.String(), "backend_http_requests_total") {
				t.Errorf("%s %s leaked backend metrics", method, target)
			}
			if rr.Code == http.StatusNotFound && strings.HasPrefix(rr.Header().Get("X-Test-Final-Path"), "/api/") &&
				metricValue("gateway_internal_path_blocked_total") == before {
				t.Errorf("%s %s: 404 on an /api path but the block counter did not move", method, target)
			}
		}
	}
}

// serveFollowingRedirects drives the handler and follows same-host redirects
// (ServeMux answers a non-canonical path with one), up to a small limit.
func serveFollowingRedirects(t *testing.T, h http.Handler, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(method, "http://gateway"+target, nil)
		req.RemoteAddr = "203.0.113.50:1000"
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		loc := rr.Header().Get("Location")
		if rr.Code < 300 || rr.Code > 399 || loc == "" {
			rr.Header().Set("X-Test-Final-Path", req.URL.Path)
			return rr
		}
		target = loc
	}
	t.Fatalf("%s %s: too many redirects", method, target)
	return nil
}

// Ordinary API paths that merely contain the word still pass.
func TestServer_MetricsGuardDoesNotBlockOrdinaryPaths(t *testing.T) {
	var got []string
	h, _ := newTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.URL.Path)
	}), nil)
	for _, target := range []string{"/api/spaces/metrics", "/api/music/insights/metrics", "/api/metricsx"} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest("GET", "http://gateway"+target, nil))
		if rr.Code != http.StatusOK {
			t.Errorf("%s: %d, want 200", target, rr.Code)
		}
	}
	want := []string{"/spaces/metrics", "/music/insights/metrics", "/metricsx"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("backend saw %v, want %v", got, want)
	}
}

// The gateway's OWN metrics are not on the public handler tree either: the
// public port is what the web proxy forwards to.
func TestServer_PublicHandlerDoesNotServeGatewayMetrics(t *testing.T) {
	var backendHits atomic.Int64
	h, _ := newTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backendHits.Add(1)
	}), nil)
	// Make sure there is something to leak.
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "http://gateway/health", nil))

	for _, target := range []string{"/metrics", "/metrics/", "/METRICS", "/debug/vars", "/debug/pprof/"} {
		rr := serveFollowingRedirects(t, h, "GET", target)
		if rr.Code != http.StatusNotFound {
			t.Errorf("GET %s on the public handler: %d, want 404", target, rr.Code)
		}
		if strings.Contains(rr.Body.String(), "gateway_http_requests_total") || strings.Contains(rr.Body.String(), "# TYPE") {
			t.Errorf("GET %s leaked metrics on the public handler", target)
		}
	}
	if backendHits.Load() != 0 {
		t.Errorf("a /metrics probe was forwarded to the backend")
	}
}

// main refuses to put the metrics listener on the public port.
func TestSameListener(t *testing.T) {
	if !sameListener("0.0.0.0:9080", 9080) || !sameListener("127.0.0.1:9080", 9080) || !sameListener("[::1]:9080", 9080) {
		t.Error("an address on the public port must be detected")
	}
	if sameListener("127.0.0.1:9091", 9080) {
		t.Error("a different port is fine")
	}
}

// Requests through the real handler tree move the counters, labelled by
// route group — and the path, pubkey and IP stay out of the labels.
func TestServer_RequestsAreCountedByRouteGroup(t *testing.T) {
	h, _ := newTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/boom") {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}), nil)

	type probe struct {
		method, target, route, status string
	}
	probes := []probe{
		{"GET", "/health", metrics.RouteHealth, "200"},
		{"GET", "/api/spaces/abc123", metrics.RouteAPI, "200"},
		{"GET", "/api/boom", metrics.RouteAPI, "500"},
		{"GET", "/hls/" + sha + "/master.m3u8", metrics.RouteHLS, "200"},
		{"GET", "/list/" + sha, metrics.RouteList, "200"},
		{"HEAD", "/upload", metrics.RouteUpload, "200"},
		{"GET", "/" + sha, metrics.RouteBlob, "200"},
		{"GET", "/no-such-thing", metrics.RouteBlob, "404"},
	}
	for _, p := range probes {
		before := metricValue("gateway_http_requests_total", p.route, p.method, p.status)
		beforeObs := metricValue("gateway_http_request_duration_seconds", p.route, p.method)
		req := httptest.NewRequest(p.method, "http://gateway"+p.target, nil)
		req.RemoteAddr = "203.0.113.61:1000"
		h.ServeHTTP(httptest.NewRecorder(), req)
		if got := metricValue("gateway_http_requests_total", p.route, p.method, p.status) - before; got != 1 {
			t.Errorf("%s %s: requests_total{%s,%s,%s} moved by %v, want 1", p.method, p.target, p.route, p.method, p.status, got)
		}
		if got := metricValue("gateway_http_request_duration_seconds", p.route, p.method) - beforeObs; got != 1 {
			t.Errorf("%s %s: duration not observed", p.method, p.target)
		}
	}

	out := dump()
	for _, leaked := range []string{sha, "abc123", "203.0.113.61", "no-such-thing", "master.m3u8"} {
		if strings.Contains(out, leaked) {
			t.Errorf("metrics output contains request data %q", leaked)
		}
	}
}

// Upstream outcomes: a 5xx is counted by class, and a backend that is gone is
// an error with a reason (and a 502 to the client).
func TestServer_UpstreamErrorsAndLatency(t *testing.T) {
	h, be := newTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}), nil)

	before5xx := metricValue("gateway_upstream_requests_total", metrics.UpstreamAPI, "5xx")
	beforeObs := metricValue("gateway_upstream_request_duration_seconds", metrics.UpstreamAPI)
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "http://gateway/api/spaces", nil))
	if metricValue("gateway_upstream_requests_total", metrics.UpstreamAPI, "5xx")-before5xx != 1 {
		t.Errorf("an upstream 503 was not counted as 5xx")
	}
	if metricValue("gateway_upstream_request_duration_seconds", metrics.UpstreamAPI)-beforeObs != 1 {
		t.Errorf("upstream latency not observed")
	}

	be.Close() // the backend is gone
	beforeRefused := metricValue("gateway_upstream_errors_total", metrics.UpstreamAPI, "connection_refused")
	beforeBlossom := metricValue("gateway_upstream_errors_total", metrics.UpstreamBlossom, "connection_refused")
	before502 := metricValue("gateway_http_requests_total", metrics.RouteAPI, "GET", "502")

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "http://gateway/api/spaces", nil))
	if rr.Code != http.StatusBadGateway {
		t.Fatalf("backend down: expected 502, got %d", rr.Code)
	}
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "http://gateway/"+sha, nil))

	if metricValue("gateway_upstream_errors_total", metrics.UpstreamAPI, "connection_refused")-beforeRefused != 1 {
		t.Errorf("api upstream connection_refused not counted")
	}
	if metricValue("gateway_upstream_errors_total", metrics.UpstreamBlossom, "connection_refused")-beforeBlossom != 1 {
		t.Errorf("blossom upstream connection_refused not counted")
	}
	if metricValue("gateway_http_requests_total", metrics.RouteAPI, "GET", "502")-before502 != 1 {
		t.Errorf("the 502 was not counted on the api route")
	}
}

// A rejected NIP-98 header through the full tree is counted by reason, and
// the auth-fail guard's 429s by bucket.
func TestServer_AuthFailuresAndThrottlingCounted(t *testing.T) {
	h, _ := newTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}), nil)
	beforeReason := metricValue("gateway_auth_failures_total", metrics.AuthInvalidBase64)
	beforeBucket := metricValue("gateway_rate_limit_rejections_total", metrics.BucketAuthFail)

	codes := []int{}
	for i := 0; i < 5; i++ { // AuthFailPerMin is 3 in the test gateway
		req := httptest.NewRequest("GET", "http://gateway/api/spaces", nil)
		req.RemoteAddr = "203.0.113.62:1000"
		req.Header.Set("Authorization", "Nostr !!!")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		codes = append(codes, rr.Code)
	}
	if got := metricValue("gateway_auth_failures_total", metrics.AuthInvalidBase64) - beforeReason; got != 3 {
		t.Errorf("invalid_base64 failures moved by %v, want 3 (codes %v)", got, codes)
	}
	if got := metricValue("gateway_rate_limit_rejections_total", metrics.BucketAuthFail) - beforeBucket; got != 2 {
		t.Errorf("auth_fail rejections moved by %v, want 2 (codes %v)", got, codes)
	}
}

// End to end over real sockets: the public listener and the metrics listener
// are different ports, and only the second one answers /metrics.
func TestServer_MetricsOnlyOnTheInternalListener(t *testing.T) {
	h, _ := newTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}), func(c *config.Config) {})
	public := httptest.NewServer(h)
	defer public.Close()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	internal := metrics.NewServer(ln.Addr().String(), metrics.Default)
	go internal.Serve(ln)
	defer internal.Close()

	get := func(url string) (int, string) {
		resp, err := http.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}

	if code, _ := get(public.URL + "/api/health"); code != http.StatusOK {
		t.Fatalf("traffic through the public listener: %d", code)
	}
	for _, path := range []string{"/metrics", "/api/metrics"} {
		code, body := get(public.URL + path)
		if code != http.StatusNotFound || strings.Contains(body, "gateway_http_requests_total") {
			t.Errorf("public listener %s: %d, leaked=%v", path, code, strings.Contains(body, "gateway_"))
		}
	}
	code, body := get("http://" + ln.Addr().String() + "/metrics")
	if code != http.StatusOK || !strings.Contains(body, `gateway_http_requests_total{route="api",method="GET",status="200"}`) {
		t.Fatalf("internal listener /metrics: %d\n%s", code, body)
	}
	// And the internal listener serves nothing else — it is not a second way
	// into the API.
	if code, _ := get("http://" + ln.Addr().String() + "/api/health"); code != http.StatusNotFound {
		t.Errorf("internal listener proxied an API path: %d", code)
	}
}
