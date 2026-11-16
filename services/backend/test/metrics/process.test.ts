/**
 * Event-loop delay is measured in fixed windows the process closes itself.
 * A scrape reads the last closed window and changes nothing, so two scrapers
 * (or a manual curl) cannot shorten each other's window — and nothing is
 * measured until the monitor is started.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Registry } from "../../src/lib/metrics/registry.js";
import { registerProcessMetrics, EVENT_LOOP_WINDOW_MS } from "../../src/lib/metrics/process.js";
import { eventLoopMonitor, registry as backendRegistry } from "../../src/lib/metrics/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hold the event loop for `ms`. */
function block(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* spin */
  }
}

function lag(out: string, name: "mean" | "p99" | "max"): number | undefined {
  const m = out.match(new RegExp(`^nodejs_eventloop_lag_${name}_seconds (.+)$`, "m"));
  return m ? Number(m[1]) : undefined;
}

describe("event-loop delay monitor", () => {
  let monitor: ReturnType<typeof registerProcessMetrics> | null = null;
  afterEach(() => {
    monitor?.stop();
    monitor = null;
  });

  it("is off after import and a scrape does not turn it on", () => {
    expect(eventLoopMonitor.running()).toBe(false);
    const out = backendRegistry.render();
    expect(eventLoopMonitor.running()).toBe(false);
    // Declared, but no sample: nothing is being measured.
    expect(out).toContain("# TYPE nodejs_eventloop_lag_p99_seconds gauge");
    expect(lag(out, "p99")).toBeUndefined();
  });

  it("publishes a window when the process closes it, not when a scrape happens", async () => {
    const registry = new Registry();
    monitor = registerProcessMetrics(registry);
    // A 1 s window leaves wide margins on both sides of each step below, so a
    // slow machine cannot push a step into the wrong window.
    monitor.start(1000);
    expect(monitor.running()).toBe(true);

    // Inside the first window: a 90 ms stall, then several scrapes.
    await sleep(20);
    block(90);
    await sleep(20);
    for (let i = 0; i < 5; i++) {
      // Nothing published yet — the window is still open — and scraping does
      // not close it.
      expect(lag(registry.render(), "max")).toBe(0);
    }

    // After the window closes (and well before the next one does), it shows
    // the stall those scrapes did not erase.
    await sleep(1050);
    const published = lag(registry.render(), "max")!;
    expect(published).toBeGreaterThan(0.05);
  });

  it("repeated scrapes read the same value: a second scraper cannot shorten the window", async () => {
    const registry = new Registry();
    monitor = registerProcessMetrics(registry);
    monitor.start(1000);
    await sleep(20);
    block(80);
    await sleep(1080); // first window closed; the second runs until ~2000 ms

    const first = registry.render();
    const again = [registry.render(), registry.render(), registry.render()];
    for (const out of again) {
      expect(lag(out, "max")).toBe(lag(first, "max"));
      expect(lag(out, "p99")).toBe(lag(first, "p99"));
      expect(lag(out, "mean")).toBe(lag(first, "mean"));
    }
    expect(lag(first, "max")).toBeGreaterThan(0.05);
  });

  it("start is idempotent and stop ends the measurement", async () => {
    const registry = new Registry();
    monitor = registerProcessMetrics(registry);
    monitor.start(40);
    monitor.start(40);
    expect(monitor.running()).toBe(true);
    monitor.stop();
    expect(monitor.running()).toBe(false);

    const before = registry.render();
    block(60);
    await sleep(120); // several would-be windows
    expect(lag(registry.render(), "max")).toBe(lag(before, "max"));
  });

  // Node's histogram records the gap between sampling-timer firings, so a
  // raw sample is the 20 ms interval plus the delay. Reported values are the
  // delay alone: an idle loop reads near zero, not a constant 20 ms.
  it("reports delay, not the sampling interval: an idle window is near zero", async () => {
    const registry = new Registry();
    monitor = registerProcessMetrics(registry);
    monitor.start(300);
    await sleep(340); // one idle window
    const out = registry.render();
    expect(lag(out, "mean")).toBeLessThan(0.015);
    expect(lag(out, "mean")).toBeGreaterThanOrEqual(0);
  });

  it("uses a 10 s window by default", () => {
    expect(EVENT_LOOP_WINDOW_MS).toBe(10_000);
  });
});
