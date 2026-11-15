package metrics

import (
	"bytes"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func render(r *Registry) string {
	var b bytes.Buffer
	r.Write(&b)
	return b.String()
}

func TestCounterRendersHelpTypeAndLabels(t *testing.T) {
	r := NewRegistry()
	c := r.NewCounter("demo_requests_total", "Requests.", "route", "status")
	c.Inc("api", "200")
	c.Inc("api", "200")
	c.Add(3, "blob", "404")

	out := render(r)
	for _, want := range []string{
		"# HELP demo_requests_total Requests.\n",
		"# TYPE demo_requests_total counter\n",
		`demo_requests_total{route="api",status="200"} 2` + "\n",
		`demo_requests_total{route="blob",status="404"} 3` + "\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if got := c.Value("api", "200"); got != 2 {
		t.Errorf("Value = %v, want 2", got)
	}
}

func TestCounterNeverDecreases(t *testing.T) {
	r := NewRegistry()
	c := r.NewCounter("demo_total", "x")
	c.Add(5)
	c.Add(-3)
	if got := c.Value(); got != 5 {
		t.Fatalf("negative Add moved a counter: %v", got)
	}
}

func TestUnlabelledMetricHasNoBraces(t *testing.T) {
	r := NewRegistry()
	r.NewGauge("demo_up", "Up.").Set(1)
	if out := render(r); !strings.Contains(out, "\ndemo_up 1\n") {
		t.Fatalf("unexpected rendering:\n%s", out)
	}
}

func TestLabelValuesAreEscaped(t *testing.T) {
	r := NewRegistry()
	r.NewCounter("demo_total", "line one\nline \\ two", "v").Inc("a\"b\\c\nd")
	out := render(r)
	if !strings.Contains(out, `# HELP demo_total line one\nline \\ two`+"\n") {
		t.Errorf("help not escaped:\n%s", out)
	}
	if !strings.Contains(out, `demo_total{v="a\"b\\c\nd"} 1`+"\n") {
		t.Errorf("label not escaped:\n%s", out)
	}
}

func TestHistogramBucketsAreCumulative(t *testing.T) {
	r := NewRegistry()
	h := r.NewHistogram("demo_seconds", "Latency.", []float64{0.1, 0.5, 1}, "route")
	for _, v := range []float64{0.05, 0.1, 0.3, 0.7, 5} {
		h.Observe(v, "api")
	}
	out := render(r)
	for _, want := range []string{
		"# TYPE demo_seconds histogram\n",
		`demo_seconds_bucket{route="api",le="0.1"} 2` + "\n", // 0.05 and the boundary value 0.1
		`demo_seconds_bucket{route="api",le="0.5"} 3` + "\n",
		`demo_seconds_bucket{route="api",le="1"} 4` + "\n",
		`demo_seconds_bucket{route="api",le="+Inf"} 5` + "\n",
		`demo_seconds_sum{route="api"} 6.15` + "\n",
		`demo_seconds_count{route="api"} 5` + "\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if h.Count("api") != 5 {
		t.Errorf("Count = %d", h.Count("api"))
	}
}

// A label fed from client input would otherwise grow without bound; the cap
// turns that bug into a counted drop instead of a memory leak.
func TestSeriesCapDropsNewLabelSets(t *testing.T) {
	r := NewRegistry()
	c := r.NewCounter("demo_total", "x", "v")
	for i := 0; i < defaultMaxSeries+50; i++ {
		c.Inc(fmt.Sprintf("value-%d", i))
	}
	if n := strings.Count(render(r), "demo_total{"); n != defaultMaxSeries {
		t.Fatalf("rendered %d series, want the cap %d", n, defaultMaxSeries)
	}
	if r.Dropped() != 50 {
		t.Fatalf("Dropped = %d, want 50", r.Dropped())
	}
	// Existing series keep counting past the cap.
	c.Inc("value-0")
	if c.Value("value-0") != 2 {
		t.Fatalf("an existing series stopped counting at the cap")
	}
}

func TestDuplicateRegistrationPanics(t *testing.T) {
	r := NewRegistry()
	r.NewCounter("demo_total", "x")
	defer func() {
		if recover() == nil {
			t.Fatal("registering the same name twice must panic")
		}
	}()
	r.NewGauge("demo_total", "y")
}

func TestWrongLabelCountPanics(t *testing.T) {
	r := NewRegistry()
	c := r.NewCounter("demo_total", "x", "a", "b")
	defer func() {
		if recover() == nil {
			t.Fatal("a missing label value must panic, not shift the values")
		}
	}()
	c.Inc("only-one")
}

func TestOnCollectRunsBeforeRender(t *testing.T) {
	r := NewRegistry()
	g := r.NewGauge("demo_live", "x")
	n := 0.0
	r.OnCollect(func() { n++; g.Set(n) })
	render(r)
	if out := render(r); !strings.Contains(out, "demo_live 2\n") {
		t.Fatalf("collector did not refresh the gauge:\n%s", out)
	}
}

func TestResetZeroesEverything(t *testing.T) {
	r := NewRegistry()
	c := r.NewCounter("demo_total", "x", "v")
	c.Inc("a")
	r.Reset()
	if c.Value("a") != 0 || strings.Contains(render(r), "demo_total{") {
		t.Fatal("Reset left a series behind")
	}
}

func TestFormatFloat(t *testing.T) {
	cases := map[float64]string{
		0:            "0",
		1:            "1",
		1794708840:   "1794708840",
		8669448:      "8669448",
		0.25:         "0.25",
		2.6792e-05:   "2.6792e-05",
		math.Inf(1):  "+Inf",
		math.Inf(-1): "-Inf",
	}
	for in, want := range cases {
		if got := formatFloat(in); got != want {
			t.Errorf("formatFloat(%v) = %q, want %q", in, got, want)
		}
	}
	if formatFloat(math.NaN()) != "NaN" {
		t.Error("NaN")
	}
}

// What the middleware costs per request, next to the same handler bare.
func BenchmarkHandlerBare(b *testing.B) {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	req := httptest.NewRequest("GET", "/api/spaces/abc", nil)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		h.ServeHTTP(httptest.NewRecorder(), req)
	}
}

func BenchmarkHandlerInstrumented(b *testing.B) {
	h := Instrument("bench", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	req := httptest.NewRequest("GET", "/api/spaces/abc", nil)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		h.ServeHTTP(httptest.NewRecorder(), req)
	}
}
