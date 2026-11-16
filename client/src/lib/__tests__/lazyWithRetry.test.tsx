import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Suspense, lazy } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ErrorBoundary, ItemBoundary } from "@/components/ui/ErrorBoundary";
import { resetCrashLogForTests } from "@/lib/crash/crashLog";
import {
  isChunkLoadError,
  lazyWithRetry,
  retryFailedLazyImports,
  setLazyImportsFailingForTests,
} from "../lazyWithRetry";

function Loaded() {
  return <div data-testid="loaded">loaded</div>;
}

/** An importer that rejects like a missing chunk until `online` is set. */
function makeImporter() {
  const state = { online: false, calls: 0 };
  const load = () => {
    state.calls += 1;
    return state.online
      ? Promise.resolve({ default: Loaded })
      : Promise.reject(new TypeError("Failed to fetch dynamically imported module: http://localhost/assets/AIChatView-abc123.js"));
  };
  return { load, state };
}

describe("lazyWithRetry", () => {
  beforeEach(() => {
    localStorage.clear();
    resetCrashLogForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setLazyImportsFailingForTests(false);
    vi.restoreAllMocks();
  });

  it("loads like React.lazy when the import succeeds", async () => {
    const View = lazyWithRetry(() => Promise.resolve({ default: Loaded }));
    render(
      <Suspense fallback={<div>loading</div>}>
        <View />
      </Suspense>,
    );
    expect(await screen.findByTestId("loaded")).toBeInTheDocument();
  });

  it("passes props through to the loaded component", async () => {
    const Greeting = lazyWithRetry(() =>
      Promise.resolve({ default: ({ name }: { name: string }) => <div>hello {name}</div> }),
    );
    render(
      <Suspense fallback={null}>
        <Greeting name="wired" />
      </Suspense>,
    );
    expect(await screen.findByText("hello wired")).toBeInTheDocument();
  });

  it("Try again re-imports a failed chunk and recovers", async () => {
    const { load, state } = makeImporter();
    const View = lazyWithRetry(load);
    render(
      <ErrorBoundary label="ai-view" variant="panel">
        <Suspense fallback={<div>loading</div>}>
          <View />
        </Suspense>
      </ErrorBoundary>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("This part of the app didn't load");
    const failedCalls = state.calls;

    // Still offline: retry imports again and lands back on the fallback.
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(state.calls).toBeGreaterThan(failedCalls));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    state.online = true;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByTestId("loaded")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("documents the problem: a plain React.lazy stays failed after a retry", async () => {
    const { load, state } = makeImporter();
    const View = lazy(load);
    render(
      <ErrorBoundary label="plain-lazy" variant="panel">
        <Suspense fallback={<div>loading</div>}>
          <View />
        </Suspense>
      </ErrorBoundary>,
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    state.online = true;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    // React cached the rejection: the importer is never called again.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(state.calls).toBe(1);
    // Which is why the fallback offers a reload for this kind of failure.
    expect(screen.getByRole("button", { name: "Reload app" })).toBeInTheDocument();
  });

  it("offers Reload in the panel and inline fallbacks for a chunk-load failure", async () => {
    const { load } = makeImporter();
    const View = lazyWithRetry(load);
    const { unmount } = render(
      <ErrorBoundary label="right.artifacts" variant="panel">
        <Suspense fallback={null}>
          <View />
        </Suspense>
      </ErrorBoundary>,
    );
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Reload app" })).toBeInTheDocument();
    unmount();

    render(
      <ItemBoundary id="x" label="picker">
        <Suspense fallback={null}>
          <View />
        </Suspense>
      </ItemBoundary>,
    );
    const inline = await screen.findByRole("status");
    expect(inline).toHaveTextContent("Part of the app didn't load.");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("does not offer Reload for an ordinary render error", () => {
    function Bomb(): never {
      throw new Error("render exploded");
    }
    render(
      <ErrorBoundary label="x" variant="panel">
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("This part of the app hit a problem");
    expect(screen.queryByRole("button", { name: "Reload app" })).toBeNull();
  });

  it("passes reloadSuggested to a custom fallback", async () => {
    const { load } = makeImporter();
    const View = lazyWithRetry(load);
    render(
      <ErrorBoundary
        label="custom"
        fallback={({ reloadSuggested }) => <div data-testid="custom">{String(reloadSuggested)}</div>}
      >
        <Suspense fallback={null}>
          <View />
        </Suspense>
      </ErrorBoundary>,
    );
    expect(await screen.findByTestId("custom")).toHaveTextContent("true");
  });

  it("re-arms only imports that failed", async () => {
    // The registry is module-wide: drain whatever earlier tests left failed.
    retryFailedLazyImports();

    const Good = lazyWithRetry(() => Promise.resolve({ default: Loaded }));
    render(
      <Suspense fallback={null}>
        <Good />
      </Suspense>,
    );
    await screen.findByTestId("loaded");
    expect(retryFailedLazyImports()).toBe(0);

    const { load } = makeImporter();
    const Bad = lazyWithRetry(load);
    render(
      <ErrorBoundary label="bad" fallback={<div data-testid="bad">failed</div>}>
        <Suspense fallback={null}>
          <Bad />
        </Suspense>
      </ErrorBoundary>,
    );
    await screen.findByTestId("bad");
    expect(retryFailedLazyImports()).toBe(1);
    expect(retryFailedLazyImports()).toBe(0);
  });

  it("the dev fault injection makes imports fail and recover", async () => {
    setLazyImportsFailingForTests(true);
    const View = lazyWithRetry(() => Promise.resolve({ default: Loaded }));
    render(
      <ErrorBoundary label="dev" variant="panel">
        <Suspense fallback={null}>
          <View />
        </Suspense>
      </ErrorBoundary>,
    );
    await screen.findByRole("alert");
    setLazyImportsFailingForTests(false);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByTestId("loaded")).toBeInTheDocument();
  });
});

describe("isChunkLoadError", () => {
  it("recognises each engine's wording", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://app.example/assets/x.js",
      "error loading dynamically imported module: https://app.example/assets/x.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/x.css",
      "Loading chunk 42 failed.",
    ]) {
      expect(isChunkLoadError(new TypeError(message))).toBe(true);
    }
    expect(isChunkLoadError(Object.assign(new Error("x"), { name: "ChunkLoadError" }))).toBe(true);
  });

  it("does not match ordinary errors or non-errors", () => {
    expect(isChunkLoadError(new TypeError("x.map is not a function"))).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});
