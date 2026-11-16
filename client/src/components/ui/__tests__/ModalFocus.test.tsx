/**
 * Where focus goes when a dialog opens and closes, in the cases that depend on
 * when in the commit the opener is recorded: a child with autoFocus, StrictMode
 * running effects twice, and one dialog replacing another in a single commit.
 */
import { describe, it, expect } from "vitest";
import { StrictMode, useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "../Modal";

function Harness({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      <Modal open={open} onClose={() => setOpen(false)} label="Dialog">
        {children ?? (
          <div>
            <button>first</button>
            <button>second</button>
          </div>
        )}
      </Modal>
    </>
  );
}

describe("focus return under StrictMode (effects run twice on mount)", () => {
  it("keeps an autoFocus child focused while open and returns focus to the opener on close", async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <Harness>
          <div>
            <button>first</button>
            <input aria-label="name" autoFocus />
          </div>
        </Harness>
      </StrictMode>,
    );
    const opener = screen.getByText("open");
    await user.click(opener);
    // The simulated unmount must not hand focus back to the opener and then
    // re-enter on the first control instead of the autoFocus one.
    expect(screen.getByLabelText("name")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("moves focus in, traps Tab and returns focus without autoFocus too", async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    const opener = screen.getByText("open");
    await user.click(opener);
    expect(screen.getByText("first")).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(screen.getByText("first")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(opener).toHaveFocus();
  });
});

describe("a dialog replaced by another in one commit (loading placeholder → real dialog)", () => {
  function LoadingThenReal({ strict = false }: { strict?: boolean }) {
    const [state, setState] = useState<"closed" | "loading" | "ready">("closed");
    const tree = (
      <>
        <button onClick={() => setState("loading")}>open</button>
        <button onClick={() => setState("ready")}>finish loading</button>
        {state === "loading" && (
          <Modal key="loading" open onClose={() => setState("closed")} label="Loading">
            <span>…</span>
          </Modal>
        )}
        {state === "ready" && (
          <Modal key="real" open onClose={() => setState("closed")} label="Add account">
            <button>first</button>
          </Modal>
        )}
      </>
    );
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  }

  it.each([
    ["plain", false],
    ["StrictMode", true],
  ])("focus ends up inside the real dialog and returns to the opener on close (%s)", async (_name, strict) => {
    const user = userEvent.setup();
    render(<LoadingThenReal strict={strict} />);
    const opener = screen.getByText("open");
    opener.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Loading" })).toHaveFocus();

    // The chunk arrives: the placeholder unmounts and the real dialog mounts together.
    fireEvent.click(screen.getByText("finish loading"));
    const real = screen.getByRole("dialog", { name: "Add account" });
    await waitFor(() => expect(real.contains(document.activeElement)).toBe(true));
    // Nothing pulls focus back out afterwards.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("first")).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });
});

describe("focus return when a render does not commit the dialog", () => {
  it("captures the opener at the commit that opens it, not at an earlier render", async () => {
    const user = userEvent.setup();
    // Two triggers; the dialog is opened from the second one after the first
    // was focused and the component re-rendered several times while closed.
    function TwoOpeners() {
      const [open, setOpen] = useState(false);
      const [, setTick] = useState(0);
      return (
        <>
          <button onFocus={() => setTick((t) => t + 1)}>first trigger</button>
          <button onClick={() => setOpen(true)}>second trigger</button>
          <Modal open={open} onClose={() => setOpen(false)} label="Dialog">
            <input aria-label="field" autoFocus />
          </Modal>
        </>
      );
    }
    render(<TwoOpeners />);
    screen.getByText("first trigger").focus();
    await user.click(screen.getByText("second trigger"));
    expect(screen.getByLabelText("field")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.getByText("second trigger")).toHaveFocus();
  });
});
