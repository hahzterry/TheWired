import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnchoredPopover } from "../AnchoredPopover";
import { Modal } from "../Modal";

beforeAll(() => {
  // jsdom has no ResizeObserver; placement is covered in anchoredPopover.test.ts.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

/** jsdom does not track input modality; say whether the trigger "has keyboard focus". */
function setFocusVisible(value: boolean) {
  const original = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
    if (selector === ":focus-visible") return value && document.activeElement === this;
    return original.call(this, selector);
  });
}
afterEach(() => vi.restoreAllMocks());

function Picker({ onPick }: { onPick?: () => void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button>before</button>
      <button ref={setAnchor} onClick={() => setOpen((o) => !o)}>
        emoji
      </button>
      <button>after</button>
      <AnchoredPopover anchorEl={anchor} open={open} onClose={() => setOpen(false)} label="Emoji picker" role="dialog">
        <div>
          <input aria-label="Search emoji" />
          <button onClick={onPick}>smile</button>
        </div>
      </AnchoredPopover>
    </>
  );
}

function Autocomplete() {
  const [anchor, setAnchor] = useState<HTMLTextAreaElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <textarea ref={setAnchor} aria-label="Message" onChange={(e) => setOpen(e.target.value.includes("@"))} />
      <AnchoredPopover anchorEl={anchor} open={open} onClose={() => setOpen(false)}>
        <button>@luna</button>
      </AnchoredPopover>
    </>
  );
}

describe("AnchoredPopover semantics", () => {
  it("passes role and label through to the popup", async () => {
    const user = userEvent.setup();
    render(<Picker />);
    await user.click(screen.getByText("emoji"));
    expect(screen.getByRole("dialog", { name: "Emoji picker" })).toBeTruthy();
  });

  it("adds no role by default", async () => {
    const user = userEvent.setup();
    render(<Autocomplete />);
    await user.type(screen.getByLabelText("Message"), "@");
    const popup = screen.getByText("@luna").parentElement!;
    expect(popup.hasAttribute("role")).toBe(false);
    expect(popup).toHaveAttribute("tabindex", "-1");
  });
});

describe("AnchoredPopover focus", () => {
  it("moves focus into the popup when opened from the keyboard", async () => {
    setFocusVisible(true);
    const user = userEvent.setup();
    render(<Picker />);
    screen.getByText("emoji").focus();
    await user.keyboard("{Enter}");
    const popup = screen.getByRole("dialog", { name: "Emoji picker" });
    expect(popup).toHaveFocus();

    // Tab now walks the popup's own controls, although it is portaled to the end of <body>.
    await user.tab();
    expect(screen.getByLabelText("Search emoji")).toHaveFocus();
    await user.tab();
    expect(screen.getByText("smile")).toHaveFocus();
  });

  it("leaves focus alone when opened with the mouse", async () => {
    setFocusVisible(false);
    const user = userEvent.setup();
    render(<Picker />);
    await user.click(screen.getByText("emoji"));
    expect(screen.getByRole("dialog")).not.toHaveFocus();
    expect(screen.getByText("emoji")).toHaveFocus();
  });

  it("never takes focus from a text field (autocomplete keeps typing)", async () => {
    setFocusVisible(true);
    const user = userEvent.setup();
    render(<Autocomplete />);
    const textarea = screen.getByLabelText("Message");
    await user.type(textarea, "hi @");
    expect(screen.getByText("@luna")).toBeTruthy();
    expect(textarea).toHaveFocus();
    await user.keyboard("l");
    expect(textarea).toHaveValue("hi @l");
  });

  it("Tab past the last control closes the popup and returns focus to the trigger", async () => {
    setFocusVisible(true);
    const user = userEvent.setup();
    render(<Picker />);
    screen.getByText("emoji").focus();
    await user.keyboard("{Enter}");
    await user.tab();
    await user.tab();
    expect(screen.getByText("smile")).toHaveFocus();
    await user.tab();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("emoji")).toHaveFocus();
  });

  it("Shift+Tab from the popup itself closes it and returns focus to the trigger", async () => {
    setFocusVisible(true);
    const user = userEvent.setup();
    render(<Picker />);
    screen.getByText("emoji").focus();
    await user.keyboard("{Enter}");
    await user.tab({ shift: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("emoji")).toHaveFocus();
  });

  it("Escape closes it and returns focus to the trigger when focus was inside", async () => {
    setFocusVisible(true);
    const user = userEvent.setup();
    render(<Picker />);
    screen.getByText("emoji").focus();
    await user.keyboard("{Enter}");
    await user.tab();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("emoji")).toHaveFocus();
  });

  it("does not pull focus back when the caller moved it on close", async () => {
    setFocusVisible(true);
    const user = userEvent.setup();
    function PickThenType() {
      const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
      const [open, setOpen] = useState(false);
      const [field, setField] = useState<HTMLTextAreaElement | null>(null);
      return (
        <>
          <textarea ref={setField} aria-label="Message" />
          <button ref={setAnchor} onClick={() => setOpen(true)}>
            emoji
          </button>
          <AnchoredPopover anchorEl={anchor} open={open} onClose={() => setOpen(false)}>
            <button
              onClick={() => {
                field?.focus();
                setOpen(false);
              }}
            >
              smile
            </button>
          </AnchoredPopover>
        </>
      );
    }
    render(<PickThenType />);
    screen.getByText("emoji").focus();
    await user.keyboard("{Enter}");
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.queryByText("smile")).toBeNull();
    expect(screen.getByLabelText("Message")).toHaveFocus();
  });

  it("does not steal focus on re-render while open (inline onClose identity changes)", async () => {
    setFocusVisible(true);
    const user = userEvent.setup();
    function Rerendering() {
      const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
      const [open, setOpen] = useState(false);
      const [, setTick] = useState(0);
      return (
        <>
          <button ref={setAnchor} onClick={() => setOpen(true)}>
            emoji
          </button>
          <AnchoredPopover anchorEl={anchor} open={open} onClose={() => setOpen(false)}>
            <input aria-label="Search emoji" onChange={() => setTick((t) => t + 1)} />
          </AnchoredPopover>
        </>
      );
    }
    render(<Rerendering />);
    screen.getByText("emoji").focus();
    await user.keyboard("{Enter}");
    await user.tab();
    const search = screen.getByLabelText("Search emoji");
    await user.keyboard("abc"); // each key re-renders the parent
    expect(search).toHaveFocus();
    expect(search).toHaveValue("abc");
  });
});

describe("AnchoredPopover dismissal", () => {
  it("closes on a press outside but not on the anchor or inside", async () => {
    const user = userEvent.setup();
    render(<Picker />);
    await user.click(screen.getByText("emoji"));
    fireEvent.mouseDown(screen.getByText("smile"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.mouseDown(screen.getByText("before"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape closes the popup only, not the dialog it was opened from", async () => {
    const user = userEvent.setup();
    const onModalClose = vi.fn();
    render(
      <Modal open onClose={onModalClose} label="Post">
        <Picker />
      </Modal>,
    );
    await user.click(screen.getByText("emoji"));
    expect(screen.getByRole("dialog", { name: "Emoji picker" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull());
    expect(onModalClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onModalClose).toHaveBeenCalledTimes(1);
  });
});
