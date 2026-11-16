/**
 * The dependency-free Prometheus registry: text exposition format, histogram
 * bucketing, and the series cap that keeps a label mistake from growing
 * memory without bound.
 */
import { describe, it, expect } from "vitest";
import { Registry, METRICS_CONTENT_TYPE, DEFAULT_MAX_SERIES, formatValue } from "../../src/lib/metrics/registry.js";

describe("Registry rendering", () => {
  it("renders HELP, TYPE and labelled counter series", () => {
    const r = new Registry();
    const c = r.counter({ name: "demo_requests_total", help: "Requests.", labelNames: ["route", "status"] as const });
    c.inc({ route: "/a/:id", status: 200 });
    c.inc({ route: "/a/:id", status: 200 });
    c.inc({ route: "/b", status: 404 }, 3);

    expect(r.render()).toBe(
      [
        "# HELP demo_requests_total Requests.",
        "# TYPE demo_requests_total counter",
        'demo_requests_total{route="/a/:id",status="200"} 2',
        'demo_requests_total{route="/b",status="404"} 3',
        "",
      ].join("\n"),
    );
    expect(c.get({ route: "/a/:id", status: 200 })).toBe(2);
    expect(c.get({ route: "/nope", status: 200 })).toBe(0);
  });

  it("renders an unlabelled metric without braces", () => {
    const r = new Registry();
    r.gauge({ name: "demo_up", help: "Up." }).set(1);
    expect(r.render()).toContain("\ndemo_up 1\n");
  });

  it("declares a metric with no samples yet (HELP/TYPE only)", () => {
    const r = new Registry();
    r.counter({ name: "demo_total", help: "x", labelNames: ["a"] as const });
    expect(r.render()).toBe("# HELP demo_total x\n# TYPE demo_total counter\n");
  });

  it("escapes help text and label values", () => {
    const r = new Registry();
    const c = r.counter({ name: "demo_total", help: "line one\nline \\ two", labelNames: ["v"] as const });
    c.inc({ v: 'a"b\\c\nd' });
    const out = r.render();
    expect(out).toContain("# HELP demo_total line one\\nline \\\\ two\n");
    expect(out).toContain('demo_total{v="a\\"b\\\\c\\nd"} 1\n');
  });

  it("formats special values the way Prometheus expects", () => {
    expect(formatValue(Infinity)).toBe("+Inf");
    expect(formatValue(-Infinity)).toBe("-Inf");
    expect(formatValue(NaN)).toBe("NaN");
    expect(formatValue(0.25)).toBe("0.25");
    expect(formatValue(1700000000)).toBe("1700000000");
  });

  it("serves the 0.0.4 text content type", () => {
    expect(METRICS_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
  });
});

describe("Counter", () => {
  it("never decreases and ignores NaN", () => {
    const c = new Registry().counter({ name: "demo_total", help: "x" });
    c.inc(undefined, 5);
    c.inc(undefined, -3);
    c.inc(undefined, NaN);
    expect(c.get()).toBe(5);
  });
});

describe("Gauge", () => {
  it("sets, increments and decrements per label set", () => {
    const g = new Registry().gauge({ name: "demo_gauge", help: "x", labelNames: ["k"] as const });
    g.set({ k: "a" }, 10);
    g.inc({ k: "a" });
    g.dec({ k: "a" }, 4);
    g.set({ k: "b" }, 0);
    expect(g.get({ k: "a" })).toBe(7);
    expect(g.get({ k: "b" })).toBe(0);
    expect(g.get({ k: "never" })).toBeUndefined();
  });
});

describe("Histogram", () => {
  it("renders cumulative buckets, +Inf, sum and count", () => {
    const r = new Registry();
    const h = r.histogram({
      name: "demo_seconds",
      help: "Latency.",
      labelNames: ["route"] as const,
      buckets: [0.1, 0.5, 1],
    });
    for (const v of [0.05, 0.1, 0.3, 0.7, 5]) h.observe({ route: "/x" }, v);

    const out = r.render();
    expect(out).toContain("# TYPE demo_seconds histogram\n");
    // 0.1 lands in le="0.1": bucket bounds are inclusive.
    expect(out).toContain('demo_seconds_bucket{route="/x",le="0.1"} 2\n');
    expect(out).toContain('demo_seconds_bucket{route="/x",le="0.5"} 3\n');
    expect(out).toContain('demo_seconds_bucket{route="/x",le="1"} 4\n');
    expect(out).toContain('demo_seconds_bucket{route="/x",le="+Inf"} 5\n');
    expect(out).toContain('demo_seconds_sum{route="/x"} 6.15\n');
    expect(out).toContain('demo_seconds_count{route="/x"} 5\n');
    expect(h.get({ route: "/x" })).toEqual({ count: 5, sum: 6.15 });
  });

  it("ignores non-finite observations", () => {
    const h = new Registry().histogram({ name: "demo_seconds", help: "x", buckets: [1] });
    h.observe(NaN);
    h.observe(Infinity);
    expect(h.get().count).toBe(0);
  });

  it("rejects buckets that do not increase", () => {
    expect(() => new Registry().histogram({ name: "demo_seconds", help: "x", buckets: [1, 1] })).toThrow();
  });
});

describe("guard rails", () => {
  it("throws on a label that was not declared", () => {
    const c = new Registry().counter({ name: "demo_total", help: "x", labelNames: ["a"] as const });
    expect(() => c.inc({ a: "1", pubkey: "abc" } as never)).toThrow(/unknown label "pubkey"/);
  });

  it("refuses duplicate names, invalid names and the reserved le label", () => {
    const r = new Registry();
    r.counter({ name: "demo_total", help: "x" });
    expect(() => r.gauge({ name: "demo_total", help: "y" })).toThrow(/already registered/);
    expect(() => r.counter({ name: "bad-name", help: "x" })).toThrow(/invalid metric name/);
    expect(() => r.counter({ name: "ok_total", help: "x", labelNames: ["le"] as const })).toThrow(/invalid label/);
  });

  // A label fed from request data would mint a series per value. The cap
  // turns that mistake into a counted drop instead of unbounded memory.
  it("stops creating series at the cap, keeps counting existing ones, and reports the drops", () => {
    const r = new Registry();
    const c = r.counter({ name: "demo_total", help: "x", labelNames: ["v"] as const, maxSeries: 10 });
    for (let i = 0; i < 25; i++) c.inc({ v: `value-${i}` });
    expect(c.seriesCount()).toBe(10);
    expect(c.droppedSeries).toBe(15);
    expect(r.droppedSeries()).toBe(15);

    c.inc({ v: "value-0" });
    expect(c.get({ v: "value-0" })).toBe(2);
    expect(DEFAULT_MAX_SERIES).toBeGreaterThanOrEqual(1000);
  });

  it("runs collectors before rendering and survives one that throws", () => {
    const r = new Registry();
    const g = r.gauge({ name: "demo_live", help: "x" });
    let n = 0;
    r.onCollect(() => {
      throw new Error("broken collector");
    });
    r.onCollect(() => g.set(++n));
    r.render();
    expect(r.render()).toContain("demo_live 2\n");
  });

  it("reset() zeroes values but keeps registrations", () => {
    const r = new Registry();
    const c = r.counter({ name: "demo_total", help: "x", labelNames: ["v"] as const });
    c.inc({ v: "a" });
    r.reset();
    expect(c.get({ v: "a" })).toBe(0);
    expect(r.names()).toEqual(["demo_total"]);
  });
});
