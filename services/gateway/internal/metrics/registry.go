// Package metrics is the gateway's Prometheus instrumentation: a small
// registry (counters, gauges, histograms with fixed label sets), the gateway's
// metric definitions, and the handler the internal listener serves.
//
// Label VALUES come from closed sets chosen in code (a route group, a failure
// reason, a rate-limit bucket) — never a pubkey, an IP, a path or anything
// else a client controls. As a backstop, each metric holds at most maxSeries
// label combinations; observations for a new combination past the cap are
// dropped and counted.
package metrics

import (
	"bytes"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// ContentType is the Prometheus text exposition format.
const ContentType = "text/plain; version=0.0.4; charset=utf-8"

const defaultMaxSeries = 500

// DurationBuckets (seconds) cover a cached read up to a slow upload reply.
var DurationBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60}

type metric interface {
	name() string
	write(w io.Writer)
	dropped() uint64
	reset()
}

// Registry holds metrics and renders them.
type Registry struct {
	mu         sync.Mutex
	metrics    []metric
	names      map[string]bool
	collectors []func()
}

func NewRegistry() *Registry {
	return &Registry{names: make(map[string]bool)}
}

func (r *Registry) register(m metric) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.names[m.name()] {
		panic("metrics: duplicate metric " + m.name())
	}
	r.names[m.name()] = true
	r.metrics = append(r.metrics, m)
}

// OnCollect runs fn right before every render, for gauges read from the
// runtime instead of pushed. fn must be cheap and do no I/O.
func (r *Registry) OnCollect(fn func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.collectors = append(r.collectors, fn)
}

// Dropped is the number of observations discarded at a series cap.
func (r *Registry) Dropped() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	var n uint64
	for _, m := range r.metrics {
		n += m.dropped()
	}
	return n
}

// Value reads one series by metric name: a counter's or gauge's value, or a
// histogram's observation count. 0 when the metric or series does not exist.
// Label values are given in the metric's declaration order.
func (r *Registry) Value(name string, labelValues ...string) float64 {
	r.mu.Lock()
	var found metric
	for _, m := range r.metrics {
		if m.name() == name {
			found = m
			break
		}
	}
	r.mu.Unlock()
	switch m := found.(type) {
	case *CounterVec:
		return m.Value(labelValues...)
	case *GaugeVec:
		return m.Value(labelValues...)
	case *HistogramVec:
		return float64(m.Count(labelValues...))
	}
	return 0
}

// Reset zeroes every metric (tests).
func (r *Registry) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, m := range r.metrics {
		m.reset()
	}
}

// Write renders every metric in the text exposition format.
//
// The exposition is built in memory first and sent to w afterwards. Each
// metric holds its own mutex while it is rendered, and that same mutex is
// taken on the request path for every increment: rendering straight into a
// network writer would let a scraper that stops reading hold it until the
// write deadline, stalling every request that touches the metric.
func (r *Registry) Write(w io.Writer) (int, error) {
	r.mu.Lock()
	collectors := append([]func(){}, r.collectors...)
	metrics := append([]metric{}, r.metrics...)
	r.mu.Unlock()
	for _, c := range collectors {
		c()
	}
	var buf bytes.Buffer
	for _, m := range metrics {
		m.write(&buf)
	}
	// No lock is held from here on.
	return w.Write(buf.Bytes())
}

// ── shared series bookkeeping ───────────────────────────────────────────────

type family struct {
	metricName string
	help       string
	labels     []string
	maxSeries  int

	mu           sync.Mutex
	droppedCount uint64
}

func (f *family) name() string { return f.metricName }

func (f *family) dropped() uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.droppedCount
}

func (f *family) key(values []string) string {
	if len(values) != len(f.labels) {
		panic(fmt.Sprintf("metrics: %s takes %d label values, got %d", f.metricName, len(f.labels), len(values)))
	}
	return strings.Join(values, "\x00")
}

func (f *family) header(w io.Writer, kind string) {
	fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n", f.metricName, escapeHelp(f.help), f.metricName, kind)
}

func (f *family) labelString(values []string, extra ...string) string {
	if len(values) == 0 && len(extra) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteByte('{')
	for i, name := range f.labels {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(name)
		b.WriteString(`="`)
		b.WriteString(escapeLabel(values[i]))
		b.WriteByte('"')
	}
	for i := 0; i+1 < len(extra); i += 2 {
		if len(f.labels) > 0 || i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(extra[i])
		b.WriteString(`="`)
		b.WriteString(escapeLabel(extra[i+1]))
		b.WriteByte('"')
	}
	b.WriteByte('}')
	return b.String()
}

func escapeHelp(s string) string {
	return strings.NewReplacer(`\`, `\\`, "\n", `\n`).Replace(s)
}

func escapeLabel(s string) string {
	return strings.NewReplacer(`\`, `\\`, "\n", `\n`, `"`, `\"`).Replace(s)
}

func formatFloat(v float64) string {
	switch {
	case math.IsNaN(v):
		return "NaN"
	case math.IsInf(v, 1):
		return "+Inf"
	case math.IsInf(v, -1):
		return "-Inf"
	}
	// Whole numbers print in full (1794708840, not 1.79470884e+09): both are
	// valid, the first is the one a person can read off a curl.
	if v == math.Trunc(v) && math.Abs(v) < 1e15 {
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return strconv.FormatFloat(v, 'g', -1, 64)
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func splitKey(key string, n int) []string {
	if n == 0 {
		return nil
	}
	return strings.Split(key, "\x00")
}

// ── Counter ─────────────────────────────────────────────────────────────────

// CounterVec is a monotonically increasing value per label combination.
type CounterVec struct {
	family
	values map[string]float64
}

func (r *Registry) NewCounter(name, help string, labels ...string) *CounterVec {
	c := &CounterVec{
		family: family{metricName: name, help: help, labels: labels, maxSeries: defaultMaxSeries},
		values: make(map[string]float64),
	}
	r.register(c)
	return c
}

// Add increases the series for the given label values (in declaration order).
func (c *CounterVec) Add(delta float64, labelValues ...string) {
	if !(delta >= 0) {
		return
	}
	key := c.key(labelValues)
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.values[key]; !ok && len(c.values) >= c.maxSeries {
		c.droppedCount++
		return
	}
	c.values[key] += delta
}

func (c *CounterVec) Inc(labelValues ...string) { c.Add(1, labelValues...) }

// setTotal mirrors a cumulative value kept elsewhere (the runtime's own
// counters), which only ever grows.
func (c *CounterVec) setTotal(v float64, labelValues ...string) {
	key := c.key(labelValues)
	c.mu.Lock()
	defer c.mu.Unlock()
	if v > c.values[key] {
		c.values[key] = v
	}
}

// Value reads a series (0 when it does not exist).
func (c *CounterVec) Value(labelValues ...string) float64 {
	key := c.key(labelValues)
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.values[key]
}

func (c *CounterVec) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.values = make(map[string]float64)
	c.droppedCount = 0
}

func (c *CounterVec) write(w io.Writer) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.header(w, "counter")
	for _, key := range sortedKeys(c.values) {
		fmt.Fprintf(w, "%s%s %s\n", c.metricName, c.labelString(splitKey(key, len(c.labels))), formatFloat(c.values[key]))
	}
}

// ── Gauge ───────────────────────────────────────────────────────────────────

// GaugeVec is a value that can go up and down, per label combination.
type GaugeVec struct {
	family
	values map[string]float64
}

func (r *Registry) NewGauge(name, help string, labels ...string) *GaugeVec {
	g := &GaugeVec{
		family: family{metricName: name, help: help, labels: labels, maxSeries: defaultMaxSeries},
		values: make(map[string]float64),
	}
	r.register(g)
	return g
}

func (g *GaugeVec) Set(v float64, labelValues ...string) {
	key := g.key(labelValues)
	g.mu.Lock()
	defer g.mu.Unlock()
	if _, ok := g.values[key]; !ok && len(g.values) >= g.maxSeries {
		g.droppedCount++
		return
	}
	g.values[key] = v
}

func (g *GaugeVec) Value(labelValues ...string) float64 {
	key := g.key(labelValues)
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.values[key]
}

func (g *GaugeVec) reset() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.values = make(map[string]float64)
	g.droppedCount = 0
}

func (g *GaugeVec) write(w io.Writer) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.header(w, "gauge")
	for _, key := range sortedKeys(g.values) {
		fmt.Fprintf(w, "%s%s %s\n", g.metricName, g.labelString(splitKey(key, len(g.labels))), formatFloat(g.values[key]))
	}
}

// ── Histogram ───────────────────────────────────────────────────────────────

type histogramSeries struct {
	counts []uint64 // per bucket, non-cumulative; last slot is the +Inf overflow
	sum    float64
	count  uint64
}

// HistogramVec counts observations into fixed buckets per label combination.
type HistogramVec struct {
	family
	buckets []float64
	series  map[string]*histogramSeries
}

func (r *Registry) NewHistogram(name, help string, buckets []float64, labels ...string) *HistogramVec {
	for i := 1; i < len(buckets); i++ {
		if !(buckets[i] > buckets[i-1]) {
			panic("metrics: buckets of " + name + " must increase")
		}
	}
	h := &HistogramVec{
		family:  family{metricName: name, help: help, labels: labels, maxSeries: defaultMaxSeries},
		buckets: append([]float64{}, buckets...),
		series:  make(map[string]*histogramSeries),
	}
	r.register(h)
	return h
}

func (h *HistogramVec) Observe(v float64, labelValues ...string) {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return
	}
	key := h.key(labelValues)
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.series[key]
	if !ok {
		if len(h.series) >= h.maxSeries {
			h.droppedCount++
			return
		}
		s = &histogramSeries{counts: make([]uint64, len(h.buckets)+1)}
		h.series[key] = s
	}
	i := sort.SearchFloat64s(h.buckets, v) // first bucket with bound >= v
	s.counts[i]++
	s.sum += v
	s.count++
}

// Count reads how many observations a series has.
func (h *HistogramVec) Count(labelValues ...string) uint64 {
	key := h.key(labelValues)
	h.mu.Lock()
	defer h.mu.Unlock()
	if s, ok := h.series[key]; ok {
		return s.count
	}
	return 0
}

func (h *HistogramVec) reset() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.series = make(map[string]*histogramSeries)
	h.droppedCount = 0
}

func (h *HistogramVec) write(w io.Writer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.header(w, "histogram")
	for _, key := range sortedKeys(h.series) {
		s := h.series[key]
		values := splitKey(key, len(h.labels))
		var cumulative uint64
		for i, bound := range h.buckets {
			cumulative += s.counts[i]
			fmt.Fprintf(w, "%s_bucket%s %d\n", h.metricName, h.labelString(values, "le", formatFloat(bound)), cumulative)
		}
		fmt.Fprintf(w, "%s_bucket%s %d\n", h.metricName, h.labelString(values, "le", "+Inf"), s.count)
		fmt.Fprintf(w, "%s_sum%s %s\n", h.metricName, h.labelString(values), formatFloat(s.sum))
		fmt.Fprintf(w, "%s_count%s %d\n", h.metricName, h.labelString(values), s.count)
	}
}
