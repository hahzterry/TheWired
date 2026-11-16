import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ErrorBoundary } from "../ErrorBoundary";
import { ModalLoading, PanelLoading } from "../LazyFallbacks";
import { LAZY_SPINNER_DELAY_MS } from "@/lib/lazyPreload";
import { lazyModal, lazyView } from "../lazyView";
import { resetCrashLogForTests } from "@/lib/crash/crashLog";
import { setLazyImportsFailingForTests } from "@/lib/lazyWithRetry";

function Page({ name }: { name: string }) {
  return <div data-testid="page">page {name}</div>;
}

function Dialog({ onClose, title }: { onClose: () => void; open?: boolean; title: string }) {
  const [count, setCount] = useState(0);
  return (
    <div role="dialog" aria-label={title}>
      <button onClick={() => setCount((c) => c + 1)}>clicked {count}</button>
      <button onClick={onClose}>close me</button>
    </div>
  );
}

/** An importer the test resolves by hand, counting how often it is called. */
function deferredImporter<T>(mod: T) {
  const state = { calls: 0, release: () => {} };
  const load = () => {
    state.calls += 1;
    return new Promise<T>((resolve) => {
      state.release = () => resolve(mod);
    });
  };
  return { load, state };
}

beforeEach(() => {
  localStorage.clear();
  resetCrashLogForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setLazyImportsFailingForTests(false);
  vi.restoreAllMocks();
});

describe("lazyView", () => {
  it("shows its fallback in the slot, then the view with its props", async () => {
    const { load, state } = deferredImporter({ default: Page });
    const View = lazyView(load, <PanelLoading label="Loading page" />);

    const { container } = render(<View name="settings" />);

    expect(container.querySelector('[data-lazy-fallback="panel"]')).not.toBeNull();
    expect(screen.queryByTestId("page")).toBeNull();

    await act(async () => state.release());

    expect(await screen.findByTestId("page")).toHaveTextContent("page settings");
    expect(container.querySelector("[data-lazy-fallback]")).toBeNull();
  });

  it("preload() starts the import before anything renders, and the render reuses it", async () => {
    const { load, state } = deferredImporter({ default: Page });
    const View = lazyView(load, null);

    View.preload();
    View.preload();
    expect(state.calls).toBe(1);
    await act(async () => state.release());

    render(<View name="x" />);
    expect(await screen.findByTestId("page")).toBeInTheDocument();
    expect(state.calls).toBe(1);
  });

  it("a failed chunk shows the Reload fallback and recovers on Try again", async () => {
    setLazyImportsFailingForTests(true); // what wiredDebug.failLazy(true) does
    const load = vi.fn(() => Promise.resolve({ default: Page }));
    const View = lazyView(load, <PanelLoading />);

    render(
      <ErrorBoundary variant="panel" label="center">
        <View name="discover" />
      </ErrorBoundary>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This part of the app didn't load");
    expect(screen.getByRole("button", { name: "Reload app" })).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();

    // Still failing: retry lands back on the fallback.
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    setLazyImportsFailingForTests(false);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByTestId("page")).toHaveTextContent("page discover");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a preload that failed does not break the view: opening it imports again and renders", async () => {
    let online = false;
    const load = vi.fn(() =>
      online ? Promise.resolve({ default: Page }) : Promise.reject(new TypeError("Importing a module script failed.")),
    );
    const View = lazyView(load, <PanelLoading />);

    // The idle preload ran while the connection was down.
    await expect(View.preload()).resolves.toBe(false);
    expect(load).toHaveBeenCalledTimes(1);

    online = true;
    render(
      <ErrorBoundary variant="panel" label="center">
        <View name="messages" />
      </ErrorBoundary>,
    );

    expect(await screen.findByTestId("page")).toHaveTextContent("page messages");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a preload that failed, then a load that fails too, lands on the same Reload fallback and retry path", async () => {
    let online = false;
    const load = vi.fn(() =>
      online ? Promise.resolve({ default: Page }) : Promise.reject(new TypeError("Importing a module script failed.")),
    );
    const View = lazyView(load, <PanelLoading />);

    await View.preload();
    render(
      <ErrorBoundary variant="panel" label="center">
        <View name="profile" />
      </ErrorBoundary>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("This part of the app didn't load");
    expect(screen.getByRole("button", { name: "Reload app" })).toBeInTheDocument();

    online = true;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByTestId("page")).toHaveTextContent("page profile");
    expect(load).toHaveBeenCalledTimes(3);
  });
});

describe("lazyModal", () => {
  it("does not request the chunk while the modal has never been open", () => {
    const { load, state } = deferredImporter({ default: Dialog });
    const Modal = lazyModal(load, "test-dialog");

    render(<Modal open={false} onClose={() => {}} title="t" />);

    expect(state.calls).toBe(0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("loads on first open and renders the modal with its props", async () => {
    const { load, state } = deferredImporter({ default: Dialog });
    const Modal = lazyModal(load, "test-dialog");

    const { rerender } = render(<Modal open={false} onClose={() => {}} title="Invite" />);
    rerender(<Modal open onClose={() => {}} title="Invite" />);
    expect(state.calls).toBe(1);

    await act(async () => state.release());
    expect(await screen.findByRole("dialog", { name: "Invite" })).toBeInTheDocument();
  });

  it("treats a modal with no `open` prop as open (conditionally rendered modals)", async () => {
    const Modal = lazyModal(() => Promise.resolve({ default: Dialog }), "test-dialog");
    render(<Modal onClose={() => {}} title="Zap" />);
    expect(await screen.findByRole("dialog", { name: "Zap" })).toBeInTheDocument();
  });

  it("stays mounted after closing, so state inside the modal survives a reopen", async () => {
    // The inner modal decides what a closed state looks like; this one keeps rendering.
    const Modal = lazyModal(() => Promise.resolve({ default: Dialog }), "test-dialog");
    const { rerender } = render(<Modal open onClose={() => {}} title="Edit" />);

    fireEvent.click(await screen.findByRole("button", { name: "clicked 0" }));
    expect(screen.getByRole("button", { name: "clicked 1" })).toBeInTheDocument();

    rerender(<Modal open={false} onClose={() => {}} title="Edit" />);
    rerender(<Modal open onClose={() => {}} title="Edit" />);
    expect(screen.getByRole("button", { name: "clicked 1" })).toBeInTheDocument();
  });

  it("a failed chunk shows a dismissible dialog with Reload, and Try again recovers", async () => {
    setLazyImportsFailingForTests(true);
    const onClose = vi.fn();
    const Modal = lazyModal(() => Promise.resolve({ default: Dialog }), "test-dialog");

    render(<Modal open onClose={onClose} title="Settings" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-boundary-fallback", "modal");
    expect(screen.getByRole("button", { name: "Reload app" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();

    setLazyImportsFailingForTests(false);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Close on the failure dialog calls the modal's own close handler", async () => {
    setLazyImportsFailingForTests(true);
    const onClose = vi.fn();
    const Modal = lazyModal(() => Promise.resolve({ default: Dialog }), "test-dialog");
    render(<Modal open onClose={onClose} title="Settings" />);

    fireEvent.click(await screen.findByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("lazy fallbacks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("PanelLoading holds the slot at once and only shows a spinner after the delay", () => {
    const { container } = render(<PanelLoading label="Loading music" />);

    const box = container.querySelector('[data-lazy-fallback="panel"]');
    expect(box).not.toBeNull();
    expect(box).toHaveClass("flex-1");
    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(LAZY_SPINNER_DELAY_MS);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Loading music");
  });

  it("ModalLoading draws nothing for a fast load, then a dismissible backdrop", () => {
    const onClose = vi.fn();
    render(<ModalLoading onClose={onClose} />);

    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(LAZY_SPINNER_DELAY_MS);
    });
    expect(screen.getByRole("dialog", { name: "Loading" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
