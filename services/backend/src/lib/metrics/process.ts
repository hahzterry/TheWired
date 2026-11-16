import type { Registry } from "./registry.js";
import { createEventLoopDelaySampler, type EventLoopDelaySampler, type SamplerClock } from "./eventLoopDelay.js";

/** How long one event-loop delay window is. */
export const EVENT_LOOP_WINDOW_MS = 10_000;

export interface EventLoopMonitor {
  /** Begin measuring event-loop delay in fixed windows. No-op if running. */
  start(windowMs?: number): void;
  stop(): void;
  running(): boolean;
}

/**
 * Process and runtime metrics, under the conventional `process_*` / `nodejs_*`
 * names so stock dashboards and alert rules apply. CPU and memory are read at
 * scrape time; none of it does I/O.
 *
 * Event-loop delay is different: it is measured over fixed windows that the
 * process itself closes (eventLoopDelay.ts), and a scrape only reads the last
 * closed window. Scraping therefore never changes what is measured — a second
 * scraper or a manual curl cannot shorten the window another one sees. The
 * measurement is off until the returned monitor is started (the metrics
 * listener does that), so a process that exports nothing measures nothing.
 *
 * `clock` is for tests: the timer and clock the delay sampler runs on.
 */
export function registerProcessMetrics(registry: Registry, clock?: SamplerClock): EventLoopMonitor {
  const cpuUser = registry.counter({
    name: "process_cpu_user_seconds_total",
    help: "User CPU time spent by the process.",
  });
  const cpuSystem = registry.counter({
    name: "process_cpu_system_seconds_total",
    help: "System CPU time spent by the process.",
  });
  const cpuTotal = registry.counter({
    name: "process_cpu_seconds_total",
    help: "User and system CPU time spent by the process.",
  });
  const startTime = registry.gauge({
    name: "process_start_time_seconds",
    help: "Unix time the process started.",
  });
  const rss = registry.gauge({
    name: "process_resident_memory_bytes",
    help: "Resident memory size.",
  });
  const heapTotal = registry.gauge({
    name: "nodejs_heap_size_total_bytes",
    help: "V8 heap size.",
  });
  const heapUsed = registry.gauge({
    name: "nodejs_heap_size_used_bytes",
    help: "V8 heap in use.",
  });
  const external = registry.gauge({
    name: "nodejs_external_memory_bytes",
    help: "Memory used by C++ objects bound to JavaScript objects.",
  });
  const lagMean = registry.gauge({
    name: "nodejs_eventloop_lag_mean_seconds",
    help: "Mean event-loop delay over the last completed 10 s window.",
  });
  const lagP99 = registry.gauge({
    name: "nodejs_eventloop_lag_p99_seconds",
    help: "99th percentile event-loop delay over the last completed 10 s window.",
  });
  const lagMax = registry.gauge({
    name: "nodejs_eventloop_lag_max_seconds",
    help: "Largest event-loop delay over the last completed 10 s window.",
  });
  const versionInfo = registry.gauge({
    name: "nodejs_version_info",
    help: "Node.js version, as a label on a constant 1.",
    labelNames: ["version"] as const,
  });

  const startedAt = Math.round(Date.now() / 1000 - process.uptime());

  // cpuUsage() is cumulative since process start; the counters advance by the
  // difference from the previous scrape.
  let lastCpu = { user: 0, system: 0 };

  registry.onCollect(() => {
    startTime.set(startedAt);
    versionInfo.set({ version: process.version }, 1);

    const cpu = process.cpuUsage();
    const user = (cpu.user - lastCpu.user) / 1e6;
    const system = (cpu.system - lastCpu.system) / 1e6;
    lastCpu = cpu;
    cpuUser.inc(undefined, user);
    cpuSystem.inc(undefined, system);
    cpuTotal.inc(undefined, user + system);

    const mem = process.memoryUsage();
    rss.set(mem.rss);
    heapTotal.set(mem.heapTotal);
    heapUsed.set(mem.heapUsed);
    external.set(mem.external);
  });

  let sampler: EventLoopDelaySampler | null = null;

  return {
    start(windowMs: number = EVENT_LOOP_WINDOW_MS) {
      if (sampler) return;
      // Present (as 0) from the start, so the series exists before the first
      // window closes.
      lagMean.set(0);
      lagP99.set(0);
      lagMax.set(0);
      sampler = createEventLoopDelaySampler({
        windowMs,
        clock,
        onWindow: (window) => {
          lagMean.set(window.mean);
          lagP99.set(window.p99);
          lagMax.set(window.max);
        },
      });
      sampler.start();
    },
    stop() {
      sampler?.stop();
      sampler = null;
    },
    running: () => sampler !== null,
  };
}
