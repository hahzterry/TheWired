/**
 * Preloading for the lazily loaded parts of the app.
 *
 * A lazy boundary only starts fetching its chunk when it first renders, which
 * puts the whole download between the click and the content. These helpers
 * start the fetch earlier: when the pointer or focus reaches the control that
 * opens the view (`preloadOnIntent`), or once the shell has settled
 * (`preloadWhenIdle`).
 *
 * `preloadable` is the piece both build on. It wraps an importer so that every
 * caller, the preload and the eventual `lazyWithRetry` render alike, shares one
 * in-flight import. A failed import is forgotten, so the next call fetches
 * again: that keeps `lazyWithRetry`'s retry working through the wrapper.
 *
 * What this module cannot forget is the engine's own memory. WebKit and Gecko
 * remember a module that failed to fetch for the life of the page: importing
 * the same URL again fails at once, without a request, and only a reload
 * clears it. So a preload that fails there breaks the real navigation later,
 * for a view the user had not even asked for yet. A preload is therefore only
 * attempted when it is likely to succeed: never while the browser reports
 * being offline, and the idle sequence checks that the origin answers before
 * its first import and stops at the first one that fails.
 */
import { isTauri } from "@/lib/platform";

/**
 * How long a lazy boundary waits before it shows a spinner. A chunk that is
 * already cached, or comes off the local disk in the desktop app, arrives well
 * inside this window, and then nothing is drawn at all: no spinner flashing in
 * and out for a few frames.
 */
export const LAZY_SPINNER_DELAY_MS = 180;

export interface PreloadableLoader<T> {
  (): Promise<T>;
  /**
   * Start the import now, unless the browser is offline. Never rejects: it
   * resolves true once the module is in, false when the attempt was skipped or
   * failed (the render that needs the module imports again).
   */
  preload: () => Promise<boolean>;
  /** True once the import has resolved. */
  isLoaded: () => boolean;
}

export function preloadable<T>(load: () => Promise<T>): PreloadableLoader<T> {
  let pending: Promise<T> | null = null;
  let loaded = false;

  const run = (): Promise<T> => {
    if (!pending) {
      const attempt: Promise<T> = load().then(
        (mod) => {
          loaded = true;
          return mod;
        },
        (error: unknown) => {
          // Forget the failure so a retry imports again.
          if (pending === attempt) pending = null;
          throw error;
        },
      );
      pending = attempt;
    }
    return pending;
  };

  const loader = run as PreloadableLoader<T>;
  loader.preload = () => {
    if (isOffline()) return Promise.resolve(false);
    return run().then(
      () => true,
      () => false,
    );
  };
  loader.isLoaded = () => loaded;
  return loader;
}

/**
 * Anything with a `preload()`: a `preloadable` loader, a `lazyView`, a
 * `lazyModal`. A `preload()` that reports false (skipped or failed) ends an
 * idle sequence; one that reports nothing is taken to have worked.
 */
export interface Preloadable {
  preload: () => void | Promise<boolean | void>;
}

/** Several targets that are opened together, preloaded as one. */
export function preloadGroup(...targets: Preloadable[]): Preloadable {
  return {
    preload: async () => {
      const results = await Promise.all(targets.map((target) => target.preload()));
      return results.every((ok) => ok !== false);
    },
  };
}

/** The browser says there is no network. (Absent or true means "maybe".) */
function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Whether the app's own origin answers right now, asked with a request that
 * cannot hurt: a failed `fetch` leaves nothing behind, where a failed
 * `import()` can cost the view until the next reload (see the top of the
 * file). Any response counts, whatever its status; only a network error means
 * no. The desktop app serves its files from its own bundle, so there is
 * nothing to ask.
 */
export async function originReachable(url: string = import.meta.url): Promise<boolean> {
  if (isOffline()) return false;
  if (isTauri || typeof fetch !== "function" || !/^https?:/.test(url)) return true;
  try {
    await fetch(url, { method: "HEAD", cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

/** The user asked the browser to save data: fetch only what they open. */
function prefersReducedData(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

export interface IntentHandlers {
  onPointerEnter: () => void;
  onFocus: () => void;
  onTouchStart: () => void;
}

const intentHandlerCache = new WeakMap<Preloadable, IntentHandlers>();

/**
 * Props to spread on the control that opens a lazy view, so its chunk starts
 * loading when the pointer, a finger or keyboard focus reaches the control.
 * The handlers are stable per target, so spreading them does not re-render.
 */
export function preloadOnIntent(target: Preloadable): IntentHandlers {
  let handlers = intentHandlerCache.get(target);
  if (!handlers) {
    const start = () => {
      void target.preload();
    };
    handlers = { onPointerEnter: start, onFocus: start, onTouchStart: start };
    intentHandlerCache.set(target, handlers);
  }
  return handlers;
}

type IdleScheduler = (run: () => void) => () => void;

/** `requestIdleCallback` where it exists (not WebKit before 17), a timer otherwise. */
const scheduleIdle: IdleScheduler = (run) => {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout: 4000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = setTimeout(run, 300);
  return () => clearTimeout(id);
};

export interface PreloadWhenIdleOptions {
  /** Wait this long before the first one, so startup work is not competing. */
  delayMs?: number;
  /** Test seam. */
  schedule?: IdleScheduler;
  /** Asked once, just before the first import. Test seam; defaults to a HEAD request to the app's origin. */
  reachable?: () => boolean | Promise<boolean>;
}

/**
 * Preload `targets` one at a time, each in its own idle slot, starting after
 * `delayMs`. One at a time, and each only after the one before has arrived, so
 * a batch of chunks never lands as a single long task while the user is
 * starting to interact. Returns a cancel function.
 *
 * Nothing is imported unless the origin answers first, and the sequence ends
 * at the first target that does not load: on a connection that has just
 * dropped, at most one import is attempted, not the whole list.
 */
export function preloadWhenIdle(
  targets: readonly Preloadable[],
  { delayMs = 1500, schedule = scheduleIdle, reachable = () => originReachable() }: PreloadWhenIdleOptions = {},
): () => void {
  if (prefersReducedData() || targets.length === 0) return () => {};

  let cancelled = false;
  let cancelSlot: (() => void) | null = null;

  const idleSlot = () =>
    new Promise<void>((resolve) => {
      cancelSlot = schedule(() => {
        cancelSlot = null;
        resolve();
      });
    });

  const run = async () => {
    for (let index = 0; index < targets.length; index += 1) {
      await idleSlot();
      if (cancelled) return;
      if (index === 0 && !(await reachable())) return;
      if (cancelled) return;
      if ((await targets[index].preload()) === false) return;
      if (cancelled) return;
    }
  };

  const timer = setTimeout(() => {
    void run();
  }, delayMs);

  return () => {
    cancelled = true;
    clearTimeout(timer);
    cancelSlot?.();
  };
}
