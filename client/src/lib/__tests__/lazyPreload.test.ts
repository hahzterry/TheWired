import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { preloadable, preloadOnIntent, preloadWhenIdle, type Preloadable } from "../lazyPreload";

describe("preloadable", () => {
  it("shares one import between a preload and later callers", async () => {
    const load = vi.fn(() => Promise.resolve({ value: 1 }));
    const loader = preloadable(load);

    loader.preload();
    const [a, b] = await Promise.all([loader(), loader()]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a).toEqual({ value: 1 });
  });

  it("reports isLoaded only once the import has resolved", async () => {
    let release!: (v: string) => void;
    const loader = preloadable(() => new Promise<string>((resolve) => (release = resolve)));

    const pending = loader();
    expect(loader.isLoaded()).toBe(false);
    release("ready");
    await pending;
    expect(loader.isLoaded()).toBe(true);
  });

  it("forgets a failed import so the next call fetches again", async () => {
    let online = false;
    const load = vi.fn(() =>
      online ? Promise.resolve("module") : Promise.reject(new TypeError("Failed to fetch dynamically imported module")),
    );
    const loader = preloadable(load);

    await expect(loader()).rejects.toThrow("Failed to fetch");
    expect(loader.isLoaded()).toBe(false);

    online = true;
    await expect(loader()).resolves.toBe("module");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a failed preload is silent: nothing throws and nothing is left unhandled", async () => {
    // (An unhandled rejection would fail the whole run: vitest reports them.)
    const loader = preloadable(() => Promise.reject(new Error("offline")));
    expect(() => loader.preload()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(loader.isLoaded()).toBe(false);
  });
});

describe("preloadOnIntent", () => {
  it("preloads on pointer, focus and touch", () => {
    const target: Preloadable = { preload: vi.fn() };
    const handlers = preloadOnIntent(target);

    handlers.onPointerEnter();
    handlers.onFocus();
    handlers.onTouchStart();

    expect(target.preload).toHaveBeenCalledTimes(3);
  });

  it("returns the same handlers for the same target, so spreading them is render-stable", () => {
    const target: Preloadable = { preload: vi.fn() };
    expect(preloadOnIntent(target)).toBe(preloadOnIntent(target));
    expect(preloadOnIntent(target)).not.toBe(preloadOnIntent({ preload: vi.fn() }));
  });
});

describe("preloadWhenIdle", () => {
  /** A scheduler the test drives by hand: each `flush()` runs one idle slot. */
  function manualScheduler() {
    const queue: Array<() => void> = [];
    const cancelled = new Set<() => void>();
    return {
      schedule: (run: () => void) => {
        queue.push(run);
        return () => cancelled.add(run);
      },
      flush: () => {
        const run = queue.shift();
        if (run && !cancelled.has(run)) run();
      },
      pending: () => queue.length,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for the delay, then preloads one target per idle slot, in order", () => {
    const order: string[] = [];
    const targets = ["a", "b", "c"].map((name) => ({ preload: () => order.push(name) }));
    const idle = manualScheduler();

    preloadWhenIdle(targets, { delayMs: 1000, schedule: idle.schedule });

    vi.advanceTimersByTime(999);
    expect(idle.pending()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(order).toEqual([]);

    idle.flush();
    expect(order).toEqual(["a"]);
    idle.flush();
    expect(order).toEqual(["a", "b"]);
    idle.flush();
    expect(order).toEqual(["a", "b", "c"]);
    expect(idle.pending()).toBe(0);
  });

  it("cancel stops it before the delay and between slots", () => {
    const first = { preload: vi.fn() };
    const second = { preload: vi.fn() };
    const idle = manualScheduler();

    const cancelEarly = preloadWhenIdle([first], { delayMs: 500, schedule: idle.schedule });
    cancelEarly();
    vi.advanceTimersByTime(500);
    idle.flush();
    expect(first.preload).not.toHaveBeenCalled();

    const cancelMid = preloadWhenIdle([first, second], { delayMs: 0, schedule: idle.schedule });
    vi.advanceTimersByTime(0);
    idle.flush();
    expect(first.preload).toHaveBeenCalledTimes(1);
    cancelMid();
    idle.flush();
    expect(second.preload).not.toHaveBeenCalled();
  });

  it("does nothing when the user asked to save data", () => {
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    const target = { preload: vi.fn() };
    const idle = manualScheduler();

    preloadWhenIdle([target], { delayMs: 0, schedule: idle.schedule });
    vi.advanceTimersByTime(10);
    idle.flush();

    expect(target.preload).not.toHaveBeenCalled();
  });

  it("falls back to a timer where requestIdleCallback is missing", () => {
    // jsdom has no requestIdleCallback, like WebKit before 17.
    expect(typeof window.requestIdleCallback).toBe("undefined");
    const target = { preload: vi.fn() };

    preloadWhenIdle([target], { delayMs: 100 });
    vi.advanceTimersByTime(100);
    expect(target.preload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(target.preload).toHaveBeenCalledTimes(1);
  });
});
