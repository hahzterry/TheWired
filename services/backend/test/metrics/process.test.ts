/**
 * Event-loop delay is measured in fixed windows the process closes itself.
 * A scrape reads the last closed window and changes nothing, so two scrapers
 * (or a manual curl) cannot shorten each other's window — and nothing is
 * measured until the monitor is started.
 *
 * Everything here except the last test runs on a fake clock and a fake
 * timer: the tests decide when the sampling timer fires and how late, so
 * they assert the logic and not how a real timer behaves on the machine
 * running them.
 */
import { describe, it, expect } from "vitest";
import { Registry } from "../../src/lib/metrics/registry.js";
import { registerProcessMetrics, EVENT_LOOP_WINDOW_MS } from "../../src/lib/metrics/process.js";
import {
  createEventLoopDelaySampler,
  SAMPLE_INTERVAL_MS,
  type DelayWindow,
  type SamplerClock,
} from "../../src/lib/metrics/eventLoopDelay.js";
import { eventLoopMonitor, registry as backendRegistry } from "../../src/lib/metrics/index.js";

/** A clock that only moves when told to, and a timer that only fires when told to. */
function fakeClock() {
  let now = 5_000;
  let callback: (() => void) | null = null;
  const calls = { setInterval: 0, clearInterval: 0, intervalMs: 0 };
  const clock: SamplerClock = {
    now: () => now,
    setInterval(fn, ms) {
      callback = fn;
      calls.setInterval += 1;
      calls.intervalMs = ms;
      return "timer";
    },
    clearInterval() {
      callback = null;
      calls.clearInterval += 1;
    },
  };
  return {
    clock,
    calls,
    armed: () => callback !== null,
    /** The timer fires `lateMs` later than the interval asked for (0 = on time). */
    fire(lateMs = 0) {
      now += SAMPLE_INTERVAL_MS + lateMs;
      callback?.();
    },
    /** `n` on-time firings: `n × 20 ms` of an idle loop. */
    idle(n: number) {
      for (let i = 0; i < n; i++) this.fire(0);
    },
  };
}

function lag(out: string, name: "mean" | "p99" | "max"): number | undefined {
  const m = out.match(new RegExp(`^nodejs_eventloop_lag_${name}_seconds (.+)$`, "m"));
  return m ? Number(m[1]) : undefined;
}

const allLag = (out: string) => [lag(out, "mean"), lag(out, "p99"), lag(out, "max")];

describe("event-loop delay sampler (fake clock)", () => {
  function sampler(windowMs: number) {
    const fake = fakeClock();
    const windows: DelayWindow[] = [];
    const s = createEventLoopDelaySampler({ windowMs, clock: fake.clock, onWindow: (w) => windows.push(w) });
    return { fake, windows, s };
  }

  it("samples on the 20 ms interval it documents", () => {
    const { fake, s } = sampler(1000);
    s.start();
    expect(fake.calls.intervalMs).toBe(20);
    expect(SAMPLE_INTERVAL_MS).toBe(20);
  });

  it("publishes nothing until a window has run its length, then exactly one window", () => {
    const { fake, windows, s } = sampler(1000);
    s.start();
    fake.idle(49); // 980 ms
    expect(windows).toHaveLength(0);
    fake.fire(); // 1000 ms
    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual({ mean: 0, p99: 0, max: 0, samples: 50 });
  });

  it("an idle loop reads zero, not the sampling interval", () => {
    const { fake, windows, s } = sampler(200);
    s.start();
    fake.idle(10);
    expect(windows[0].max).toBe(0);
    expect(windows[0].mean).toBe(0);
  });

  it("reports a stall as the time the timer fired late", () => {
    const { fake, windows, s } = sampler(1000);
    s.start();
    fake.idle(5); // 100 ms
    fake.fire(90); // the loop was busy for 90 ms: this firing comes 110 ms after the last
    fake.idle(40); // 100 + 110 + 800 = 1010 ms: closes on the 46th firing
    expect(windows).toHaveLength(1);
    expect(windows[0].max).toBeCloseTo(0.09, 9);
    expect(windows[0].samples).toBe(46);
    expect(windows[0].mean).toBeCloseTo(0.09 / 46, 9);
  });

  // The failure this file used to have on some machines: a stall that began
  // before the sampler's first firing was never measured, because the first
  // firing of a native delay histogram only arms its baseline.
  it("measures a stall that begins before the very first firing", () => {
    const { fake, windows, s } = sampler(200);
    s.start();
    fake.fire(80); // the first firing itself is 80 ms late
    fake.idle(9);
    expect(windows[0].max).toBeCloseTo(0.08, 9);
  });

  it("measures a stall that begins right after a window closes", () => {
    const { fake, windows, s } = sampler(200);
    s.start();
    fake.idle(10); // closes window 1 on the 10th firing
    expect(windows).toHaveLength(1);
    fake.fire(70); // first firing of window 2 is late
    fake.idle(9);
    expect(windows).toHaveLength(2);
    expect(windows[1].max).toBeCloseTo(0.07, 9);
  });

  // A stall that straddles the moment a window was due to close must land in
  // a window, exactly once. (With a resettable histogram and a separate
  // window timer it could land in neither.)
  it("a stall across a window boundary lands in the window that was open, once", () => {
    const { fake, windows, s } = sampler(1000);
    s.start();
    fake.idle(49); // 980 ms into the window
    fake.fire(300); // busy from 980 ms to 1300 ms: the boundary is inside the stall
    expect(windows).toHaveLength(1);
    expect(windows[0].max).toBeCloseTo(0.3, 9);

    fake.idle(50);
    expect(windows).toHaveLength(2);
    expect(windows[1].max).toBe(0); // not counted again in the next window
  });

  it("a stall longer than several windows closes one window carrying it", () => {
    const { fake, windows, s } = sampler(1000);
    s.start();
    fake.idle(3);
    fake.fire(25_000);
    expect(windows).toHaveLength(1);
    expect(windows[0].max).toBeCloseTo(25, 9);
    fake.idle(50);
    expect(windows).toHaveLength(2);
  });

  it("computes mean, 99th percentile and max over the window's samples", () => {
    const { fake, windows, s } = sampler(2500);
    s.start();
    // 100 firings: 97 on time, then 10 ms, 20 ms and 500 ms late.
    fake.idle(97); // 1940 ms
    fake.fire(10); // 1970 ms
    fake.fire(20); // 2010 ms
    expect(windows).toHaveLength(0);
    fake.fire(500); // 2530 ms ≥ the 2500 ms window: closed on this firing
    expect(windows).toHaveLength(1);
    const w = windows[0];
    expect(w.samples).toBe(100);
    expect(w.max).toBeCloseTo(0.5, 9);
    expect(w.mean).toBeCloseTo(0.53 / 100, 9);
    // Nearest rank: the 99th of 100 sorted samples is the 20 ms one.
    expect(w.p99).toBeCloseTo(0.02, 9);
  });

  it("never reports a negative delay when the timer fires early", () => {
    const { fake, windows, s } = sampler(100);
    s.start();
    fake.fire(-5);
    fake.fire(-20);
    fake.idle(6);
    expect(windows[0].max).toBe(0);
    expect(windows[0].mean).toBe(0);
  });

  it("each window starts clean", () => {
    const { fake, windows, s } = sampler(200);
    s.start();
    fake.fire(150);
    fake.idle(9);
    fake.idle(10);
    expect(windows.map((w) => w.max)).toEqual([expect.closeTo(0.15, 9), 0]);
  });

  it("start is idempotent, stop clears the timer, and a stopped sampler measures nothing", () => {
    const { fake, windows, s } = sampler(100);
    expect(s.running()).toBe(false);
    s.start();
    s.start();
    expect(fake.calls.setInterval).toBe(1);
    expect(s.running()).toBe(true);

    s.stop();
    s.stop();
    expect(fake.calls.clearInterval).toBe(1);
    expect(fake.armed()).toBe(false);
    expect(s.running()).toBe(false);
    fake.idle(20);
    expect(windows).toHaveLength(0);
  });

  it("can be started again after a stop, without carrying the gap over as a stall", () => {
    const { fake, windows, s } = sampler(100);
    s.start();
    fake.idle(2);
    s.stop();
    fake.idle(500); // ten seconds pass while stopped (the fake timer is disarmed)
    s.start();
    fake.idle(5);
    expect(windows).toHaveLength(1);
    expect(windows[0].max).toBe(0);
  });
});

describe("event-loop delay gauges (fake clock)", () => {
  function monitor() {
    const fake = fakeClock();
    const registry = new Registry();
    const m = registerProcessMetrics(registry, fake.clock);
    return { fake, registry, m };
  }

  it("is off after import and a scrape does not turn it on", () => {
    expect(eventLoopMonitor.running()).toBe(false);
    const out = backendRegistry.render();
    expect(eventLoopMonitor.running()).toBe(false);
    // Declared, but no sample: nothing is being measured.
    expect(out).toContain("# TYPE nodejs_eventloop_lag_p99_seconds gauge");
    expect(lag(out, "p99")).toBeUndefined();
  });

  it("exports zeros from start until the first window closes", () => {
    const { fake, registry, m } = monitor();
    m.start(1000);
    expect(m.running()).toBe(true);
    expect(allLag(registry.render())).toEqual([0, 0, 0]);
    fake.fire(90);
    fake.idle(10);
    // A stall has happened, but its window is still open.
    expect(allLag(registry.render())).toEqual([0, 0, 0]);
  });

  it("publishes a window when it closes, not when a scrape happens", () => {
    const { fake, registry, m } = monitor();
    m.start(1000);
    fake.idle(5);
    fake.fire(90);
    // Scrapes while the window is open do not publish it.
    for (let i = 0; i < 5; i++) expect(lag(registry.render(), "max")).toBe(0);
    fake.idle(39); // 100 + 110 + 780 = 990 ms: still open
    expect(lag(registry.render(), "max")).toBe(0);
    fake.fire(); // 1010 ms: the firing that closes it
    expect(lag(registry.render(), "max")).toBeCloseTo(0.09, 9);
  });

  it("the closed window shows a stall that scrapes during it did not erase", () => {
    const { fake, registry, m } = monitor();
    m.start(1000);
    fake.idle(5);
    fake.fire(90);
    for (let i = 0; i < 5; i++) registry.render();
    fake.idle(40); // 100 + 110 + 800 = 1010 ms: the window closes on the last firing
    const out = registry.render();
    expect(lag(out, "max")).toBeCloseTo(0.09, 9);
    // Nearest rank over 46 samples: the top 1% is the single largest sample.
    expect(lag(out, "p99")).toBeCloseTo(0.09, 9);
    expect(lag(out, "mean")).toBeCloseTo(0.09 / 46, 9);
  });

  it("repeated scrapes read the same value: a second scraper cannot shorten the window", () => {
    const { fake, registry, m } = monitor();
    m.start(1000);
    fake.fire(80);
    fake.idle(49); // closes window 1 carrying the 80 ms stall
    const first = registry.render();
    expect(lag(first, "max")).toBeCloseTo(0.08, 9);

    // Any number of scrapes, with the next window already under way.
    fake.idle(20);
    for (let i = 0; i < 10; i++) expect(allLag(registry.render())).toEqual(allLag(first));

    // Only the next close changes what scrapes see.
    fake.idle(30);
    expect(lag(registry.render(), "max")).toBe(0);
  });

  it("stop ends the measurement and keeps the last published window", () => {
    const { fake, registry, m } = monitor();
    m.start(200);
    fake.fire(60);
    fake.idle(9);
    const published = allLag(registry.render());
    m.stop();
    expect(m.running()).toBe(false);
    expect(fake.armed()).toBe(false);
    fake.idle(100);
    expect(allLag(registry.render())).toEqual(published);
  });

  it("start is idempotent", () => {
    const { fake, m } = monitor();
    m.start(200);
    m.start(200);
    expect(fake.calls.setInterval).toBe(1);
  });

  it("uses a 10 s window by default", () => {
    const { fake, registry, m } = monitor();
    expect(EVENT_LOOP_WINDOW_MS).toBe(10_000);
    m.start();
    fake.fire(40);
    fake.idle(497); // 60 + 9940 = 10 000 ms
    expect(lag(registry.render(), "max")).toBeCloseTo(0.04, 9);
  });
});

// One check against the real clock and a real timer. It asserts only what
// holds on any machine however slow or fast: windows do get closed, and each
// is well-formed (finite, non-negative, max ≥ p99 and mean). It makes no
// claim about how large a delay is or when a particular stall is seen.
describe("event-loop delay on a real timer (smoke)", () => {
  it("closes well-formed windows", async () => {
    const windows: DelayWindow[] = [];
    const sampler = createEventLoopDelaySampler({ windowMs: 40, onWindow: (w) => windows.push(w) });
    sampler.start();
    try {
      const deadline = Date.now() + 30_000;
      while (windows.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    } finally {
      sampler.stop();
    }

    expect(windows.length).toBeGreaterThanOrEqual(2);
    for (const w of windows) {
      for (const v of [w.mean, w.p99, w.max]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expect(w.max).toBeGreaterThanOrEqual(w.p99);
      expect(w.max).toBeGreaterThanOrEqual(w.mean);
      expect(w.samples).toBeGreaterThanOrEqual(1);
    }
    expect(sampler.running()).toBe(false);
  });

  it("the default monitor starts and stops on the real timer", () => {
    const monitor = registerProcessMetrics(new Registry());
    monitor.start();
    expect(monitor.running()).toBe(true);
    monitor.stop();
    expect(monitor.running()).toBe(false);
  });
});
