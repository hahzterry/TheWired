import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CopyDiagnosticsButton, ErrorBoundary, ItemBoundary } from "../ErrorBoundary";
import { BoundaryResetContext } from "../boundaryReset";
import { getCrashRecords, resetCrashLogForTests } from "@/lib/crash/crashLog";
import { armDevCrash } from "@/lib/crash/devCrashProbe";

/** Throws while `shouldThrow.current` is set; counts its render attempts. */
function makeBomb() {
  const state = { explode: true, renders: 0 };
  function Bomb({ text = "content" }: { text?: string }) {
    state.renders += 1;
    if (state.explode) throw new Error("render exploded");
    return <div data-testid="content">{text}</div>;
  }
  return { Bomb, state };
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    localStorage.clear();
    resetCrashLogForTests();
    // React logs caught errors; keep the test output readable.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    armDevCrash();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary label="test">
        <div data-testid="content">fine</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("content")).toHaveTextContent("fine");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the fallback when a child throws and records the crash", () => {
    const { Bomb } = makeBomb();
    render(
      <ErrorBoundary label="sidebar" variant="panel">
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("This part of the app hit a problem");
    expect(screen.queryByTestId("content")).toBeNull();

    const [record] = getCrashRecords();
    expect(record).toMatchObject({
      source: "boundary",
      boundary: "panel:sidebar",
      name: "Error",
      message: "render exploded",
    });
    expect(record.componentStack).toContain("Bomb");
  });

  it("retry re-mounts the children and recovers once the cause is gone", () => {
    const { Bomb, state } = makeBomb();
    render(
      <ErrorBoundary label="test">
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Still broken: retry lands back on the fallback.
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(screen.getByRole("alert")).toBeInTheDocument();

    state.explode = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(screen.getByTestId("content")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("resets when a reset key changes", () => {
    const { Bomb, state } = makeBomb();
    const { rerender } = render(
      <ErrorBoundary label="test" resetKeys={["a"]}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Same keys (a fresh array with equal contents): stays on the fallback.
    state.explode = false;
    rerender(
      <ErrorBoundary label="test" resetKeys={["a"]}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(
      <ErrorBoundary label="test" resetKeys={["b"]}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });

  it("does not retry in a loop when the key change itself brings the failing content", () => {
    const { Bomb, state } = makeBomb();
    state.explode = false;
    const { rerender } = render(
      <ErrorBoundary label="test" resetKeys={["a"]}>
        <Bomb />
      </ErrorBoundary>,
    );
    const before = state.renders;

    // New identity and it throws: one failed attempt, not an immediate second.
    state.explode = true;
    rerender(
      <ErrorBoundary label="test" resetKeys={["b"]}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // React may re-run a failed render once itself before giving up; what
    // matters is that the boundary does not add a reset on top.
    expect(state.renders - before).toBeLessThanOrEqual(2);
    expect(getCrashRecords()).toHaveLength(1);
    expect(getCrashRecords()[0].count).toBe(1);
  });

  it("resets on navigation (the epoch from BoundaryResetContext)", () => {
    const { Bomb, state } = makeBomb();
    function Harness() {
      const [epoch, setEpoch] = useState("/feed");
      return (
        <BoundaryResetContext.Provider value={epoch}>
          <button onClick={() => setEpoch("/settings")}>navigate</button>
          <ErrorBoundary label="center">
            <Bomb />
          </ErrorBoundary>
        </BoundaryResetContext.Provider>
      );
    }
    render(<Harness />);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    state.explode = false;
    fireEvent.click(screen.getByText("navigate"));
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });

  it("resets nested item boundaries on navigation too", () => {
    const { Bomb, state } = makeBomb();
    function Harness() {
      const [epoch, setEpoch] = useState("a");
      return (
        <BoundaryResetContext.Provider value={epoch}>
          <button onClick={() => setEpoch("b")}>navigate</button>
          <ErrorBoundary label="center">
            <ItemBoundary id="note-1" label="note" noun="note">
              <Bomb />
            </ItemBoundary>
          </ErrorBoundary>
        </BoundaryResetContext.Provider>
      );
    }
    render(<Harness />);
    expect(screen.getByRole("status")).toHaveTextContent("This note couldn't be displayed.");
    state.explode = false;
    fireEvent.click(screen.getByText("navigate"));
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });

  it("a healthy boundary does no work when the user navigates", () => {
    // The provider owns the epoch and takes the tree as `children`, as in the
    // app: only context consumers re-render when it changes.
    function Provider({ children }: { children: ReactNode }) {
      const [epoch, setEpoch] = useState("a");
      return (
        <BoundaryResetContext.Provider value={epoch}>
          <button onClick={() => setEpoch((e) => e + "x")}>navigate</button>
          {children}
        </BoundaryResetContext.Provider>
      );
    }
    const { Bomb, state } = makeBomb();
    const boundaryRender = vi.spyOn(ErrorBoundary.prototype, "render");
    render(
      <Provider>
        {Array.from({ length: 50 }, (_, i) => (
          <ItemBoundary key={i} id={`ok-${i}`} label="note">
            <div>item {i}</div>
          </ItemBoundary>
        ))}
        <ItemBoundary id="bad" label="note" noun="note">
          <Bomb />
        </ItemBoundary>
      </Provider>,
    );
    expect(screen.getByRole("status")).toBeInTheDocument();

    boundaryRender.mockClear();
    state.explode = false;
    fireEvent.click(screen.getByText("navigate"));

    // The failed boundary reset and recovered...
    expect(screen.getByTestId("content")).toBeInTheDocument();
    // ...and only it rendered. The 50 healthy ones were not touched.
    expect(boundaryRender.mock.calls.length).toBeLessThanOrEqual(2);

    boundaryRender.mockClear();
    fireEvent.click(screen.getByText("navigate"));
    expect(boundaryRender).not.toHaveBeenCalled();
  });

  it("a boundary with an empty or custom fallback still resets on navigation", () => {
    const { Bomb, state } = makeBomb();
    function Harness() {
      const [epoch, setEpoch] = useState("a");
      return (
        <BoundaryResetContext.Provider value={epoch}>
          <button onClick={() => setEpoch("b")}>navigate</button>
          <ErrorBoundary label="toasts" fallback={null}>
            <Bomb text="silent" />
          </ErrorBoundary>
          <ErrorBoundary label="custom" fallback={() => <div data-testid="custom">custom</div>}>
            <Bomb text="custom" />
          </ErrorBoundary>
        </BoundaryResetContext.Provider>
      );
    }
    render(<Harness />);
    expect(screen.queryByTestId("content")).toBeNull();
    expect(screen.getByTestId("custom")).toBeInTheDocument();

    state.explode = false;
    fireEvent.click(screen.getByText("navigate"));
    expect(screen.getAllByTestId("content").map((n) => n.textContent)).toEqual(["silent", "custom"]);
  });

  it("does not loop when the destination of a navigation fails too", () => {
    const { Bomb, state } = makeBomb();
    function Harness() {
      const [epoch, setEpoch] = useState("a");
      return (
        <BoundaryResetContext.Provider value={epoch}>
          <button onClick={() => setEpoch((e) => e + "x")}>navigate</button>
          <ErrorBoundary label="center">
            <Bomb />
          </ErrorBoundary>
        </BoundaryResetContext.Provider>
      );
    }
    render(<Harness />);
    const before = state.renders;
    fireEvent.click(screen.getByText("navigate"));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // One fresh attempt for the new location (React may run it twice), no more.
    expect(state.renders - before).toBeLessThanOrEqual(2);
    expect(getCrashRecords()).toHaveLength(1);
    expect(getCrashRecords()[0].count).toBe(2);
  });

  it("catches at the nearest boundary only", () => {
    const { Bomb } = makeBomb();
    render(
      <ErrorBoundary label="outer" variant="screen">
        <div data-testid="sibling">sibling</div>
        <ErrorBoundary label="inner" variant="inline" noun="message">
          <Bomb />
        </ErrorBoundary>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("sibling")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("This message couldn't be displayed.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getCrashRecords().map((r) => r.boundary)).toEqual(["inline:inner"]);
  });

  it("renders each variant's fallback", () => {
    const { Bomb } = makeBomb();
    const { unmount } = render(
      <ErrorBoundary label="root" variant="screen">
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveAttribute("data-boundary-fallback", "screen");
    expect(screen.getByRole("heading", { name: "The Wired hit a problem" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload app" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy diagnostics" })).toBeInTheDocument();
    unmount();

    render(
      <ItemBoundary id="x" label="note">
        <Bomb />
      </ItemBoundary>,
    );
    const inline = screen.getByRole("status");
    expect(inline).toHaveAttribute("data-boundary-fallback", "inline");
    expect(inline).toHaveTextContent("This couldn't be displayed.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(getCrashRecords().map((r) => r.boundary)).toEqual(["screen:root", "item:note"]);
  });

  it("supports a custom fallback and a silent one", () => {
    const { Bomb, state } = makeBomb();
    const { unmount, container } = render(
      <ErrorBoundary label="toasts" fallback={null}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(getCrashRecords()).toHaveLength(1);
    unmount();

    render(
      <ErrorBoundary
        label="custom"
        fallback={({ retry, summary }) => (
          <button onClick={retry}>custom retry: {summary}</button>
        )}
      >
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("button")).toHaveTextContent("custom retry: Error: render exploded");
    state.explode = false;
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });

  it("calls onError and onReset", () => {
    const { Bomb, state } = makeBomb();
    const onError = vi.fn();
    const onReset = vi.fn();
    render(
      <ErrorBoundary label="test" onError={onError} onReset={onReset}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ componentStack: expect.any(String) }));
    state.explode = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("shows only a redacted summary, never the raw error text", () => {
    function Leaky(): never {
      throw new Error('could not parse "my private message" for nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5');
    }
    render(
      <ErrorBoundary label="test">
        <Leaky />
      </ErrorBoundary>,
    );
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("my private message");
    expect(text).not.toContain("nsec1vl029");
  });

  it("an item boundary gives a different item a fresh attempt", () => {
    function Item({ id }: { id: string }) {
      if (id === "bad") throw new Error("bad item");
      return <div data-testid="content">{id}</div>;
    }
    const { rerender } = render(
      <ItemBoundary id="bad" label="note" noun="note">
        <Item id="bad" />
      </ItemBoundary>,
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
    rerender(
      <ItemBoundary id="good" label="note" noun="note">
        <Item id="good" />
      </ItemBoundary>,
    );
    expect(screen.getByTestId("content")).toHaveTextContent("good");
  });

  it("the dev crash probe makes a named boundary's content throw, and disarming recovers", () => {
    render(
      <>
        <ErrorBoundary label="sidebar" variant="panel">
          <div data-testid="sidebar">sidebar</div>
        </ErrorBoundary>
        <ItemBoundary id="n1" label="note">
          <div data-testid="n1">n1</div>
        </ItemBoundary>
        <ItemBoundary id="n2" label="note">
          <div data-testid="n2">n2</div>
        </ItemBoundary>
      </>,
    );

    act(() => armDevCrash("item:note", { id: "n2" }));
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("n1")).toBeInTheDocument();
    expect(screen.queryByTestId("n2")).toBeNull();

    act(() => armDevCrash());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByTestId("n2")).toBeInTheDocument();
  });
});

describe("CopyDiagnosticsButton", () => {
  beforeEach(() => {
    localStorage.clear();
    resetCrashLogForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies the diagnostics text and confirms", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { userAgent: "test-agent", clipboard: { writeText } });
    render(<CopyDiagnosticsButton />);
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("Copied"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("The Wired diagnostics"));
  });

  it("says so when the clipboard is unavailable", async () => {
    vi.stubGlobal("navigator", { userAgent: "test-agent" });
    render(<CopyDiagnosticsButton appearance="icon" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Couldn't copy" })).toBeInTheDocument());
  });
});
