package metrics

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestInstrumentCountsByRouteMethodAndStatus(t *testing.T) {
	h := Instrument("test_route", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/missing" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte("ok")) // implicit 200
	}))

	before200 := httpRequests.Value("test_route", "GET", "200")
	before404 := httpRequests.Value("test_route", "GET", "404")
	beforeObs := httpDuration.Count("test_route", "GET")

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/a/b/c", nil))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x/y/z", nil))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/missing", nil))

	if got := httpRequests.Value("test_route", "GET", "200") - before200; got != 2 {
		t.Errorf("200 count moved by %v, want 2", got)
	}
	if got := httpRequests.Value("test_route", "GET", "404") - before404; got != 1 {
		t.Errorf("404 count moved by %v, want 1", got)
	}
	if got := httpDuration.Count("test_route", "GET") - beforeObs; got != 3 {
		t.Errorf("duration observations moved by %d, want 3", got)
	}
}

// Paths, query strings and odd methods must never become label values.
func TestInstrumentLabelsStayBounded(t *testing.T) {
	h := Instrument("bounded_route", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	for _, path := range []string{"/a", "/b?pubkey=abc", "/" + strings.Repeat("f", 64), "/music/x/y"} {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", path, nil))
	}
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("BREW", "/a", nil))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("PROPFIND", "/a", nil))

	var b strings.Builder
	Default.Write(&b)
	var series []string
	for _, line := range strings.Split(b.String(), "\n") {
		if strings.HasPrefix(line, `gateway_http_requests_total{route="bounded_route"`) {
			series = append(series, line)
		}
	}
	if len(series) != 2 {
		t.Fatalf("want 2 series (GET, OTHER), got %d:\n%s", len(series), strings.Join(series, "\n"))
	}
	for _, s := range series {
		if strings.Contains(s, "BREW") || strings.Contains(s, "PROPFIND") || strings.Contains(s, "pubkey") || strings.Contains(s, "ffff") {
			t.Errorf("unbounded value leaked into a label: %s", s)
		}
	}
	if httpRequests.Value("bounded_route", "OTHER", "200") != 2 {
		t.Errorf("unknown methods should share the OTHER label")
	}
}

// The wrapper must not hide Flush from the reverse proxy (streamed blobs).
func TestStatusWriterKeepsFlushAndUnwrap(t *testing.T) {
	rec := httptest.NewRecorder()
	h := Instrument("flush_route", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := w.(http.Flusher); !ok {
			t.Error("wrapped writer lost http.Flusher")
		}
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Errorf("ResponseController.Flush through the wrapper: %v", err)
		}
	}))
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if !rec.Flushed {
		t.Error("flush did not reach the underlying writer")
	}
}

func TestRateLimitBucketsAreAClosedSet(t *testing.T) {
	before := rateLimitRejections.Value("other")
	RateLimitRejection("anon:203.0.113.9") // a caller passing the wrong thing
	if rateLimitRejections.Value("other")-before != 1 {
		t.Fatal("an unknown bucket must collapse to \"other\"")
	}
	beforeRead := rateLimitRejections.Value("read")
	RateLimitRejection("read")
	if rateLimitRejections.Value("read")-beforeRead != 1 {
		t.Fatal("known bucket not counted")
	}
}

func TestRateLimitStoreErrorOutcome(t *testing.T) {
	a, r := rateLimitStoreErrors.Value("ip", "allowed"), rateLimitStoreErrors.Value("replay", "rejected")
	RateLimitStoreError("ip", true)
	RateLimitStoreError("replay", false)
	if rateLimitStoreErrors.Value("ip", "allowed")-a != 1 || rateLimitStoreErrors.Value("replay", "rejected")-r != 1 {
		t.Fatal("store error outcomes not counted")
	}
}

type fakeTransport struct {
	resp *http.Response
	err  error
}

func (f fakeTransport) RoundTrip(*http.Request) (*http.Response, error) { return f.resp, f.err }

func TestInstrumentTransportClassifiesOutcomes(t *testing.T) {
	req := httptest.NewRequest("GET", "http://backend/x", nil)
	cases := []struct {
		name      string
		transport fakeTransport
		class     string
		reason    string
	}{
		{"2xx", fakeTransport{resp: &http.Response{StatusCode: 204, Body: http.NoBody}}, "2xx", ""},
		{"4xx", fakeTransport{resp: &http.Response{StatusCode: 404, Body: http.NoBody}}, "4xx", ""},
		{"5xx", fakeTransport{resp: &http.Response{StatusCode: 503, Body: http.NoBody}}, "5xx", ""},
		{"refused", fakeTransport{err: &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}}, "error", "connection_refused"},
		{"timeout", fakeTransport{err: context.DeadlineExceeded}, "error", "timeout"},
		{"canceled", fakeTransport{err: context.Canceled}, "error", "client_canceled"},
		{"dns", fakeTransport{err: &net.DNSError{Err: "no such host", Name: "backend"}}, "error", "dns"},
		{"other", fakeTransport{err: errors.New("boom")}, "error", "other"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			up := "test_" + tc.name
			rt := InstrumentTransport(up, tc.transport)
			rt.RoundTrip(req)
			if upstreamRequests.Value(up, tc.class) != 1 {
				t.Errorf("upstream_requests{%s,%s} not counted", up, tc.class)
			}
			if upstreamDuration.Count(up) != 1 {
				t.Errorf("upstream duration not observed")
			}
			if tc.reason != "" && upstreamErrors.Value(up, tc.reason) != 1 {
				t.Errorf("upstream_errors{%s,%s} not counted", up, tc.reason)
			}
		})
	}
}

// A real refused connection, through a real transport.
func TestInstrumentTransportRealConnectionRefused(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close() // nothing listens here now

	rt := InstrumentTransport("test_real_refused", &http.Transport{})
	req, _ := http.NewRequest("GET", "http://"+addr+"/", nil)
	if _, err := rt.RoundTrip(req); err == nil {
		t.Fatal("expected a dial error")
	}
	if upstreamErrors.Value("test_real_refused", "connection_refused") != 1 {
		t.Fatalf("refused dial not classified as connection_refused")
	}
}

func TestParseAddr(t *testing.T) {
	ok := map[string]string{
		"":               "",
		"  ":             "",
		"9091":           "127.0.0.1:9091",
		":9091":          "127.0.0.1:9091",
		"127.0.0.1:9091": "127.0.0.1:9091",
		"0.0.0.0:9091":   "0.0.0.0:9091",
		"[::1]:9091":     "[::1]:9091",
		"metrics:9091":   "metrics:9091",
	}
	for in, want := range ok {
		got, err := ParseAddr(in)
		if err != nil || got != want {
			t.Errorf("ParseAddr(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"abc", "host:", "host:abc", "0", ":0", "70000", "::1:9091", "http://x:1"} {
		if got, err := ParseAddr(in); err == nil {
			t.Errorf("ParseAddr(%q) = %q, want an error", in, got)
		}
	}
}

func TestHandlerServesOnlyMetrics(t *testing.T) {
	reg := NewRegistry()
	reg.NewCounter("demo_total", "Demo.").Inc()
	h := Handler(reg)

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/metrics", nil))
	if rr.Code != 200 || rr.Header().Get("Content-Type") != ContentType {
		t.Fatalf("GET /metrics: %d %q", rr.Code, rr.Header().Get("Content-Type"))
	}
	if !strings.Contains(rr.Body.String(), "demo_total 1\n") {
		t.Fatalf("body:\n%s", rr.Body.String())
	}

	for _, path := range []string{"/", "/metrics/", "/metrics/x", "/health", "/debug/pprof/", "/api/metrics"} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
		if rr.Code != http.StatusNotFound {
			t.Errorf("GET %s on the metrics listener: %d, want 404", path, rr.Code)
		}
	}

	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("POST", "/metrics", nil))
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /metrics: %d, want 405", rr.Code)
	}
}

// The listener end to end: a real socket on loopback.
func TestServerListensAndServes(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := NewServer(ln.Addr().String(), Default)
	go srv.Serve(ln)
	defer srv.Close()

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://" + ln.Addr().String() + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	for _, want := range []string{
		"# TYPE gateway_http_requests_total counter",
		"# TYPE gateway_http_request_duration_seconds histogram",
		"# TYPE gateway_auth_failures_total counter",
		"# TYPE gateway_rate_limit_rejections_total counter",
		"# TYPE gateway_upstream_errors_total counter",
		"# TYPE gateway_upstream_request_duration_seconds histogram",
		"go_goroutines ",
		"process_start_time_seconds ",
	} {
		if !strings.Contains(string(body), want) {
			t.Errorf("metrics output is missing %q", want)
		}
	}
}

// docs/METRICS.md is the operator's reference: a metric added without a doc
// row, or documented but removed, fails here.
func TestDocListsExactlyTheGatewayMetrics(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/METRICS.md")
	if err != nil {
		t.Fatalf("read docs/METRICS.md: %v", err)
	}
	doc := string(raw)
	start := strings.Index(doc, "## Gateway metrics")
	end := strings.Index(doc, "## Example scrape configuration")
	if start < 0 || end < start {
		t.Fatal("docs/METRICS.md: gateway section not found")
	}
	documented := map[string]bool{}
	for _, m := range regexp.MustCompile("(?m)^\\| `([a-z_0-9]+)`").FindAllStringSubmatch(doc[start:end], -1) {
		documented[m[1]] = true
	}

	var b strings.Builder
	Default.Write(&b)
	registered := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^# TYPE (\S+) `).FindAllStringSubmatch(b.String(), -1) {
		registered[m[1]] = true
	}

	for name := range registered {
		if !documented[name] {
			t.Errorf("%s is exported but not documented", name)
		}
	}
	for name := range documented {
		if !registered[name] {
			t.Errorf("%s is documented but not exported", name)
		}
	}
	if len(registered) == 0 {
		t.Fatal("no metrics registered")
	}
}
