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
 */

/**
 * How long a lazy boundary waits before it shows a spinner. A chunk that is
 * already cached, or comes off the local disk in the desktop app, arrives well
 * inside this window, and then nothing is drawn at all: no spinner flashing in
 * and out for a few frames.
 */
export const LAZY_SPINNER_DELAY_MS = 180;

export interface PreloadableLoader<T> {
  (): Promise<T>;
  /** Start the import now and swallow a failure (the render that needs it will retry). */
  preload: () => void;
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
    run().catch(() => {});
  };
  loader.isLoaded = () => loaded;
  return loader;
}

/** Anything with a `preload()`: a `preloadable` loader, a `lazyView`, a `lazyModal`. */
export interface Preloadable {
  preload: () => void;
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
    const start = () => target.preload();
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
}

/**
 * Preload `targets` one at a time, each in its own idle slot, starting after
 * `delayMs`. One at a time so a batch of chunks never lands as a single long
 * task while the user is starting to interact. Returns a cancel function.
 */
export function preloadWhenIdle(
  targets: readonly Preloadable[],
  { delayMs = 1500, schedule = scheduleIdle }: PreloadWhenIdleOptions = {},
): () => void {
  if (prefersReducedData() || targets.length === 0) return () => {};

  let cancelled = false;
  let cancelSlot: (() => void) | null = null;
  let index = 0;

  const next = () => {
    cancelSlot = null;
    if (cancelled || index >= targets.length) return;
    targets[index].preload();
    index += 1;
    if (index < targets.length) cancelSlot = schedule(next);
  };

  const timer = setTimeout(() => {
    if (!cancelled) cancelSlot = schedule(next);
  }, delayMs);

  return () => {
    cancelled = true;
    clearTimeout(timer);
    cancelSlot?.();
  };
}
