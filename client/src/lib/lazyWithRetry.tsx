/**
 * `React.lazy` that can be retried.
 *
 * `React.lazy` caches the promise it was given, including a rejected one: once
 * an import fails, every later render of that lazy component re-throws the
 * same error, so an error boundary's Retry can never recover it. This wrapper
 * keeps the lazy component behind a swappable reference. When an import has
 * failed, `retryFailedLazyImports()` replaces the reference with a fresh
 * `lazy()`, and the next render imports again.
 *
 * `ErrorBoundary` calls `retryFailedLazyImports()` on every reset, so using
 * this in place of `lazy` is all a call site has to do.
 *
 * A retry cannot fix everything. After a deploy the old chunk is gone for
 * good, and some engines remember a failed module fetch for the life of the
 * page. `isChunkLoadError` lets a fallback recognise the case and offer a
 * reload as well.
 */
import {
  createElement,
  lazy,
  useSyncExternalStore,
  type ComponentProps,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import { registerDebugCommand } from "@/lib/debug/logger";

/** One entry per `lazyWithRetry` call. Returns true when it re-armed a failed import. */
const retryHooks = new Set<() => boolean>();

/** Errors that came out of a `lazyWithRetry` importer, whatever their message. */
const failedImportErrors = new WeakSet<object>();

/** How each engine words a module that could not be fetched. */
const CHUNK_LOAD_PATTERNS = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Gecko
  /Importing a module script failed/i, // WebKit
  /Unable to preload CSS/i, // Vite's preload helper
  /Loading (?:CSS )?chunk [\w-]+ failed/i, // webpack-style runtimes
];

/** Dev builds only: make every `lazyWithRetry` importer reject. See the bottom of the file. */
let devFailImports = false;

/**
 * True when an error means "a piece of the app could not be loaded", as
 * opposed to "a piece of the app has a bug". Reloading is the remedy for the
 * first and useless for the second.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (failedImportErrors.has(error)) return true;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") return true;
  return typeof message === "string" && CHUNK_LOAD_PATTERNS.some((re) => re.test(message));
}

/**
 * Re-arm every `lazyWithRetry` component whose import failed, so its next
 * render imports again. Returns how many were re-armed.
 */
export function retryFailedLazyImports(): number {
  let rearmed = 0;
  for (const retry of retryHooks) {
    if (retry()) rearmed += 1;
  }
  return rearmed;
}

/**
 * Drop-in replacement for `React.lazy` whose failed import can be retried.
 * Typed like `React.lazy`: generic over the component, not its props.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRetry<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): ComponentType<ComponentProps<T>> {
  let failed = false;
  const listeners = new Set<() => void>();

  const tracked = async (): Promise<{ default: T }> => {
    try {
      if (import.meta.env.DEV && devFailImports) {
        throw new TypeError("Failed to fetch dynamically imported module (dev fault injection)");
      }
      return await load();
    } catch (error) {
      failed = true;
      if (typeof error === "object" && error !== null) failedImportErrors.add(error);
      throw error;
    }
  };

  let current: LazyExoticComponent<T> = lazy(tracked);

  retryHooks.add(() => {
    if (!failed) return false;
    failed = false;
    current = lazy(tracked);
    for (const listener of listeners) listener();
    return true;
  });

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const getCurrent = () => current;

  function Retryable(props: ComponentProps<T>) {
    const Current = useSyncExternalStore(subscribe, getCurrent, getCurrent);
    return createElement(Current as ComponentType<ComponentProps<T>>, props);
  }
  Retryable.displayName = "LazyWithRetry";
  return Retryable;
}

if (import.meta.env.DEV) {
  // wiredDebug.failLazy(true) makes lazy imports fail until failLazy(false),
  // to exercise the chunk-load path without pulling the network cable.
  registerDebugCommand("failLazy", (on) => {
    devFailImports = on !== false;
    return devFailImports ? "lazy imports will fail" : "lazy imports restored";
  });
}

/** Test seam for the dev fault injection. */
export function setLazyImportsFailingForTests(on: boolean): void {
  devFailImports = on;
}
