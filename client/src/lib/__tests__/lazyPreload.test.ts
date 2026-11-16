import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  originReachable,
  preloadable,
  preloadGroup,
  preloadOnIntent,
  preloadWhenIdle,
  type Preloadable,
} from "../lazyPreload";

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

  it("a failed preload is silent: it reports false, and nothing is left unhandled", async () => {
    // (An unhandled rejection would fail the whole run: vitest reports them.)
    const loader = preloadable(() => Promise.reject(new Error("offline")));
    await expect(loader.preload()).resolves.toBe(false);
    expect(loader.isLoaded()).toBe(false);
  });

  it("a successful preload reports true", async () => {
    const loader = preloadable(() => Promise.resolve("module"));
    await expect(loader.preload()).resolves.toBe(true);
    expect(loader.isLoaded()).toBe(true);
  });

  it("a failed preload does not poison the real load: the next call imports again and succeeds", async () => {
    let online = false;
    const load = vi.fn(() =>
      online ? Promise.resolve("module") : Promise.reject(new TypeError("Importing a module script failed.")),
    );
    const loader = preloadable(load);

    await loader.preload();
    await loader.preload();
    expect(load).toHaveBeenCalledTimes(2);

    online = true;
    await expect(loader()).resolves.toBe("module");
    expect(load).toHaveBeenCalledTimes(3);
  });

  describe("while the browser is offline", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("preload() does not import at all (a failed import can stick until a reload)", async () => {
      vi.stubGlobal("navigator", { onLine: false });
      const load = vi.fn(() => Promise.resolve("module"));
      const loader = preloadable(load);

      await expect(loader.preload()).resolves.toBe(false);
      expect(load).not.toHaveBeenCalled();
    });

    it("the real load still goes ahead: only speculation is held back", async () => {
      vi.stubGlobal("navigator", { onLine: false });
      const load = vi.fn(() => Promise.resolve("module"));
      const loader = preloadable(load);

      await expect(loader()).resolves.toBe("module");
      expect(load).toHaveBeenCalledTimes(1);
    });
  });
});

describe("preloadGroup", () => {
  it("preloads every member and reports true when all of them loaded", async () => {
    const a = { preload: vi.fn(async () => true) };
    const b = { preload: vi.fn() }; // reports nothing: taken to have worked
    await expect(preloadGroup(a, b).preload()).resolves.toBe(true);
    expect(a.preload).toHaveBeenCalledTimes(1);
    expect(b.preload).toHaveBeenCalledTimes(1);
  });

  it("reports false when any member did not load", async () => {
    const a = { preload: vi.fn(async () => true) };
    const b = { preload: vi.fn(async () => false) };
    await expect(preloadGroup(a, b).preload()).resolves.toBe(false);
  });
});


describe("originReachable", () => {
  const CHUNK = "https://app.example/assets/index-abc.js";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks with a HEAD request that bypasses the cache, and any response counts as reachable", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(originReachable(CHUNK)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(CHUNK, { method: "HEAD", cache: "no-store" });
  });

  it("is false when the request fails at the network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(originReachable(CHUNK)).resolves.toBe(false);
  });

  it("is false without asking while the browser is offline", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { onLine: false });

    await expect(originReachable(CHUNK)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not ask when the app is not served over http (bundled files cannot drop out)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(originReachable("tauri://localhost/assets/index-abc.js")).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
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
      /** Run one idle slot, then let the sequence's promises settle. */
      flush: async () => {
        const run = queue.shift();
        if (run && !cancelled.has(run)) run();
        await vi.advanceTimersByTimeAsync(0);
      },
      pending: () => queue.length,
    };
  }

  const named = (order: string[], name: string, ok: boolean | void = true): Preloadable => ({
    preload: async () => {
      order.push(name);
      return ok;
    },
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for the delay, then preloads one target per idle slot, in order", async () => {
    const order: string[] = [];
    const targets = ["a", "b", "c"].map((name) => named(order, name));
    const idle = manualScheduler();

    preloadWhenIdle(targets, { delayMs: 1000, schedule: idle.schedule, reachable: () => true });

    await vi.advanceTimersByTimeAsync(999);
    expect(idle.pending()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual([]);

    await idle.flush();
    expect(order).toEqual(["a"]);
    await idle.flush();
    expect(order).toEqual(["a", "b"]);
    await idle.flush();
    expect(order).toEqual(["a", "b", "c"]);
    expect(idle.pending()).toBe(0);
  });

  it("starts the next target only once the one before has arrived", async () => {
    const order: string[] = [];
    let arrive!: (ok: boolean) => void;
    const slow: Preloadable = {
      preload: () => {
        order.push("slow");
        return new Promise<boolean>((resolve) => (arrive = resolve));
      },
    };
    const idle = manualScheduler();

    preloadWhenIdle([slow, named(order, "next")], { delayMs: 0, schedule: idle.schedule, reachable: () => true });
    await vi.advanceTimersByTimeAsync(0);
    await idle.flush();
    expect(order).toEqual(["slow"]);
    expect(idle.pending()).toBe(0);

    arrive(true);
    await vi.advanceTimersByTimeAsync(0);
    await idle.flush();
    expect(order).toEqual(["slow", "next"]);
  });

  it("imports nothing when the origin does not answer", async () => {
    const order: string[] = [];
    const reachable = vi.fn(async () => false);
    const idle = manualScheduler();

    preloadWhenIdle([named(order, "a"), named(order, "b")], { delayMs: 0, schedule: idle.schedule, reachable });
    await vi.advanceTimersByTimeAsync(0);
    await idle.flush();
    await idle.flush();

    expect(reachable).toHaveBeenCalledTimes(1);
    expect(order).toEqual([]);
    expect(idle.pending()).toBe(0);
  });

  it("asks whether the origin answers once, right before the first import", async () => {
    const order: string[] = [];
    const reachable = vi.fn(async () => {
      order.push("reachable?");
      return true;
    });
    const idle = manualScheduler();

    preloadWhenIdle([named(order, "a"), named(order, "b")], { delayMs: 0, schedule: idle.schedule, reachable });
    await vi.advanceTimersByTimeAsync(0);
    expect(reachable).not.toHaveBeenCalled();
    await idle.flush();
    await idle.flush();

    expect(order).toEqual(["reachable?", "a", "b"]);
  });

  it("stops at the first target that fails to load, so a dropped connection costs one attempt", async () => {
    const order: string[] = [];
    const idle = manualScheduler();

    preloadWhenIdle([named(order, "a"), named(order, "b", false), named(order, "c")], {
      delayMs: 0,
      schedule: idle.schedule,
      reachable: () => true,
    });
    await vi.advanceTimersByTimeAsync(0);
    await idle.flush();
    await idle.flush();
    await idle.flush();

    expect(order).toEqual(["a", "b"]);
    expect(idle.pending()).toBe(0);
  });

  it("with real loaders: the one that fails ends the sequence, and its view still loads on demand later", async () => {
    let online = false;
    const failing = preloadable(
      vi.fn(() => (online ? Promise.resolve("messages") : Promise.reject(new TypeError("Importing a module script failed.")))),
    );
    const after = preloadable(vi.fn(() => Promise.resolve("profile")));
    const idle = manualScheduler();

    preloadWhenIdle([failing, after], { delayMs: 0, schedule: idle.schedule, reachable: () => true });
    await vi.advanceTimersByTimeAsync(0);
    await idle.flush();
    await idle.flush();

    expect(failing.isLoaded()).toBe(false);
    expect(after.isLoaded()).toBe(false);

    online = true;
    await expect(failing()).resolves.toBe("messages");
    await expect(after()).resolves.toBe("profile");
  });

  it("cancel stops it before the delay and between slots", async () => {
    const first = { preload: vi.fn(async () => true) };
    const second = { preload: vi.fn(async () => true) };
    const idle = manualScheduler();

    const cancelEarly = preloadWhenIdle([first], { delayMs: 500, schedule: idle.schedule, reachable: () => true });
    cancelEarly();
    await vi.advanceTimersByTimeAsync(500);
    await idle.flush();
    expect(first.preload).not.toHaveBeenCalled();

    const cancelMid = preloadWhenIdle([first, second], { delayMs: 0, schedule: idle.schedule, reachable: () => true });
    await vi.advanceTimersByTimeAsync(0);
    await idle.flush();
    expect(first.preload).toHaveBeenCalledTimes(1);
    cancelMid();
    await idle.flush();
    expect(second.preload).not.toHaveBeenCalled();
  });

  it("does nothing when the user asked to save data", async () => {
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    const target = { preload: vi.fn() };
    const idle = manualScheduler();

    preloadWhenIdle([target], { delayMs: 0, schedule: idle.schedule, reachable: () => true });
    await vi.advanceTimersByTimeAsync(10);
    await idle.flush();

    expect(target.preload).not.toHaveBeenCalled();
  });

  it("does nothing while the browser is offline (default reachability check)", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const target = { preload: vi.fn() };
    const idle = manualScheduler();

    preloadWhenIdle([target], { delayMs: 0, schedule: idle.schedule });
    await vi.advanceTimersByTimeAsync(0);
    await idle.flush();

    expect(target.preload).not.toHaveBeenCalled();
  });

  it("falls back to a timer where requestIdleCallback is missing", async () => {
    // jsdom has no requestIdleCallback, like WebKit before 17 and WKWebView.
    expect(typeof window.requestIdleCallback).toBe("undefined");
    const target = { preload: vi.fn() };

    preloadWhenIdle([target], { delayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(target.preload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(target.preload).toHaveBeenCalledTimes(1);
  });
});
