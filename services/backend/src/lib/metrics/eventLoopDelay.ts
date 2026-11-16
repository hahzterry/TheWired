/**
 * Event-loop delay, measured by a repeating timer and reported in fixed
 * windows.
 *
 * A timer asked to fire every `intervalMs` fires late by however long the
 * loop was busy, so the gap between two firings, less the interval, is the
 * delay. Every gap is one sample. When a firing finds that the current window
 * has run its length, the window is closed: its mean, 99th percentile and max
 * are handed to `onWindow`, and the next window starts.
 *
 * Why not `perf_hooks.monitorEventLoopDelay`: its histogram has to be reset
 * to start a new window, and the first tick after a reset (or after enable)
 * records nothing — it only re-arms the baseline. A stall that began before
 * that tick was never sampled, so a stall straddling a window close could
 * vanish from both windows. Here the baseline is never dropped: the firing
 * that follows a stall records it into the window that is open, and only
 * then decides whether that window is over. There is one timer, so "sample"
 * and "close" cannot race.
 */

/** How often the sampling timer is asked to fire. */
export const SAMPLE_INTERVAL_MS = 20;

/** Samples kept per window for the percentile; later ones still count toward
 *  mean and max. A 10 s window at 20 ms has 500. */
const MAX_WINDOW_SAMPLES = 5000;

/** One closed window. Delays are in seconds. */
export interface DelayWindow {
  mean: number;
  p99: number;
  max: number;
  /** How many timer firings the window covers. */
  samples: number;
}

/** The clock and timer the sampler runs on; tests supply their own. */
export interface SamplerClock {
  /** Monotonic milliseconds. */
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realClock: SamplerClock = {
  now: () => performance.now(),
  setInterval: (fn, ms) => {
    const timer = setInterval(fn, ms);
    timer.unref?.(); // never hold the process open to measure it
    return timer;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface EventLoopDelaySampler {
  /** Begin sampling. No-op if already running. */
  start(): void;
  stop(): void;
  running(): boolean;
}

export function createEventLoopDelaySampler(opts: {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Called with each window as it closes. */
  onWindow: (window: DelayWindow) => void;
  clock?: SamplerClock;
  intervalMs?: number;
}): EventLoopDelaySampler {
  const clock = opts.clock ?? realClock;
  const intervalMs = opts.intervalMs ?? SAMPLE_INTERVAL_MS;

  let handle: unknown = null;
  let active = false;
  /** When the timer last fired (or sampling started). Kept across windows. */
  let lastFiredAt = 0;
  let windowStartedAt = 0;
  let delays: number[] = [];
  let sum = 0;
  let max = 0;
  let count = 0;

  const openWindow = (at: number) => {
    windowStartedAt = at;
    delays = [];
    sum = 0;
    max = 0;
    count = 0;
  };

  const closeWindow = (at: number) => {
    let p99 = 0;
    if (delays.length > 0) {
      const sorted = [...delays].sort((a, b) => a - b);
      p99 = sorted[Math.max(0, Math.ceil(sorted.length * 0.99) - 1)];
    }
    opts.onWindow({ mean: count > 0 ? sum / count : 0, p99, max, samples: count });
    openWindow(at);
  };

  const onFire = () => {
    const now = clock.now();
    // A firing can never be early by more than timer granularity; clamp so a
    // coarse clock cannot produce a negative delay.
    const delay = Math.max(0, now - lastFiredAt - intervalMs) / 1000;
    lastFiredAt = now;

    count += 1;
    sum += delay;
    if (delay > max) max = delay;
    if (delays.length < MAX_WINDOW_SAMPLES) delays.push(delay);

    // Record first, close second: the firing that ends a stall puts the stall
    // in the window that was open while it happened.
    if (now - windowStartedAt >= opts.windowMs) closeWindow(now);
  };

  return {
    start() {
      if (active) return;
      active = true;
      lastFiredAt = clock.now();
      openWindow(lastFiredAt);
      handle = clock.setInterval(onFire, intervalMs);
    },
    stop() {
      if (!active) return;
      active = false;
      clock.clearInterval(handle);
      handle = null;
    },
    running: () => active,
  };
}
