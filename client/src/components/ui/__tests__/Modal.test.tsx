import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal, ModalTitle } from "../Modal";
import { ConfirmDialog } from "../ConfirmDialog";
import { PopoverMenu, PopoverMenuItem } from "../PopoverMenu";

function Harness({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      <Modal open={open} onClose={() => setOpen(false)}>
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

describe("Modal a11y", () => {
  it("exposes a dialog role + aria-modal", () => {
    render(
      <Modal open onClose={() => {}}>
        <button>x</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("moves focus into the dialog on open", async () => {
    render(
      <Modal open onClose={() => {}}>
        <div>
          <button>first</button>
          <button>second</button>
        </div>
      </Modal>,
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("first")));
  });

  it("traps Tab within the dialog (wraps last → first and first → last)", async () => {
    render(
      <Modal open onClose={() => {}}>
        <div>
          <button>first</button>
          <button>second</button>
        </div>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    const first = screen.getByText("first");
    const last = screen.getByText("second");
    await waitFor(() => expect(document.activeElement).toBe(first));

    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("restores focus to the opener on close", async () => {
    render(<Harness />);
    const opener = screen.getByText("open");
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("first")));
    // Esc closes the modal (window keydown handler) → focus returns to the opener.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe("Modal keyboard journey (real Tab presses)", () => {
  it("cycles through the dialog's controls and never reaches the page behind", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button>behind</button>
        <Harness />
      </>,
    );
    await user.click(screen.getByText("open"));
    const first = screen.getByText("first");
    const second = screen.getByText("second");
    expect(first).toHaveFocus();

    await user.tab();
    expect(second).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(second).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("open")).toHaveFocus();
  });

  it("returns focus to the opener even when a child takes focus with autoFocus", async () => {
    const user = userEvent.setup();
    render(
      <Harness>
        <div>
          <button>first</button>
          <input aria-label="name" autoFocus />
        </div>
      </Harness>,
    );
    await user.click(screen.getByText("open"));
    expect(screen.getByLabelText("name")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.getByText("open")).toHaveFocus();
  });

  it("re-enters the dialog on Tab when focus fell back to <body>", async () => {
    const user = userEvent.setup();
    function Disappearing() {
      const [shown, setShown] = useState(true);
      return (
        <div>
          <button>stays</button>
          {shown && <button onClick={() => setShown(false)}>goes</button>}
        </div>
      );
    }
    render(
      <Modal open onClose={() => {}}>
        <Disappearing />
      </Modal>,
    );
    const goes = screen.getByText("goes");
    goes.focus();
    await user.click(goes); // the focused control unmounts
    expect(document.body).toHaveFocus();
    await user.tab();
    expect(screen.getByText("stays")).toHaveFocus();
  });
});

describe("Modal accessible name", () => {
  it("is named by the title it is given with <ModalTitle>", () => {
    render(
      <Modal open onClose={() => {}}>
        <div>
          <ModalTitle className="text-lg">Create space</ModalTitle>
          <button>ok</button>
        </div>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Create space" });
    const title = screen.getByRole("heading", { level: 2, name: "Create space" });
    expect(title).toHaveClass("text-lg");
    expect(dialog.getAttribute("aria-labelledby")).toBe(title.id);
  });

  it("is not named by a heading that merely comes first in its content", () => {
    // A note, an article or a profile name rendered inside a dialog.
    render(
      <Modal open onClose={() => {}}>
        <article>
          <h1>GM, this is my note</h1>
          <h2 id="content-heading">A section of someone's article</h2>
        </article>
        <button>Close</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).not.toHaveAttribute("aria-labelledby");
    expect(dialog).not.toHaveAccessibleName();
    // Content is left exactly as rendered: no ids written onto it.
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveAttribute("id");
    expect(screen.getByRole("heading", { level: 2 })).toHaveAttribute("id", "content-heading");
  });

  it("uses the title, not content headings around it", () => {
    render(
      <Modal open onClose={() => {}}>
        <h1>Someone's display name</h1>
        <ModalTitle as="h3">Share profile</ModalTitle>
        <h2>About</h2>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Share profile" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Share profile" })).toBeTruthy();
  });

  it("keeps an id the caller put on the title", () => {
    render(
      <Modal open onClose={() => {}}>
        <ModalTitle id="my-title">Invite</ModalTitle>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Invite" }).getAttribute("aria-labelledby")).toBe("my-title");
  });

  it("follows the title when a multi-step dialog swaps it", async () => {
    function Steps() {
      const [step, setStep] = useState(1);
      return (
        <div>
          {step === 1 ? <ModalTitle key="a">Step one</ModalTitle> : <ModalTitle key="b">Step two</ModalTitle>}
          <button onClick={() => setStep(2)}>next</button>
        </div>
      );
    }
    render(
      <Modal open onClose={() => {}}>
        <Steps />
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Step one" })).toBeTruthy();
    fireEvent.click(screen.getByText("next"));
    expect(screen.getByRole("dialog", { name: "Step two" })).toBeTruthy();
  });

  it("drops the reference when the title unmounts", () => {
    function Optional() {
      const [shown, setShown] = useState(true);
      return (
        <div>
          {shown && <ModalTitle>Temporary</ModalTitle>}
          <button onClick={() => setShown(false)}>hide</button>
        </div>
      );
    }
    render(
      <Modal open onClose={() => {}}>
        <Optional />
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Temporary" })).toBeTruthy();
    fireEvent.click(screen.getByText("hide"));
    expect(screen.getByRole("dialog")).not.toHaveAttribute("aria-labelledby");
  });

  it("names a title-less dialog with the label prop, which wins over a title", () => {
    const { rerender } = render(
      <Modal open onClose={() => {}} label="Settings">
        <button>only</button>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Settings" })).not.toHaveAttribute("aria-labelledby");

    rerender(
      <Modal open onClose={() => {}} label="Settings">
        <ModalTitle>Ignored</ModalTitle>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Settings" })).not.toHaveAttribute("aria-labelledby");

    rerender(
      <Modal open onClose={() => {}} labelledBy="custom">
        <ModalTitle>Ignored</ModalTitle>
        <p id="custom">Custom name</p>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Custom name" })).toBeTruthy();
  });

  it("a title in a nested dialog names that dialog only", () => {
    render(
      <Modal open onClose={() => {}}>
        <ModalTitle>Outer</ModalTitle>
        <Modal open onClose={() => {}}>
          <ModalTitle>Inner</ModalTitle>
        </Modal>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Inner" })).toBeTruthy();
  });

  it("<ModalTitle> outside a dialog is just a heading", () => {
    render(<ModalTitle as="h3">Standalone</ModalTitle>);
    expect(screen.getByRole("heading", { level: 3, name: "Standalone" })).toBeTruthy();
  });
});

describe("Modal pointer behaviour", () => {
  it("closes on a press on the backdrop, not on a press inside the content", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose}>
        <div data-testid="panel">
          <button>inside</button>
        </div>
      </Modal>,
    );
    fireEvent.mouseDown(screen.getByTestId("panel"));
    fireEvent.mouseDown(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = screen.getByRole("dialog").querySelector('[role="presentation"]')!;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog element free of mouse handlers' side effects: a press on it does not close", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose}>
        <button>inside</button>
      </Modal>,
    );
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not let clicks inside the portal reach React ancestors", () => {
    const onCardClick = vi.fn();
    render(
      <div onClick={onCardClick}>
        <Modal open onClose={() => {}}>
          <button>inside</button>
        </Modal>
      </div>,
    );
    fireEvent.click(screen.getByText("inside"));
    expect(onCardClick).not.toHaveBeenCalled();
  });
});

describe("stacked overlays", () => {
  it("Escape closes only the top dialog", async () => {
    const user = userEvent.setup();
    function Stack() {
      const [outer, setOuter] = useState(true);
      const [inner, setInner] = useState(false);
      return (
        <Modal open={outer} onClose={() => setOuter(false)} label="Outer">
          <button onClick={() => setInner(true)}>open inner</button>
          <Modal open={inner} onClose={() => setInner(false)} label="Inner">
            <button>inner button</button>
          </Modal>
        </Modal>
      );
    }
    render(<Stack />);
    await user.click(screen.getByText("open inner"));
    expect(screen.getByRole("dialog", { name: "Inner" })).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeTruthy();
    expect(screen.getByText("open inner")).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape closes a menu opened inside a dialog and leaves the dialog open", async () => {
    const user = userEvent.setup();
    function WithMenu() {
      const [open, setOpen] = useState(true);
      const [menu, setMenu] = useState(false);
      return (
        <Modal open={open} onClose={() => setOpen(false)} label="Outer">
          <div className="relative">
            <button onClick={() => setMenu(true)}>more</button>
            <PopoverMenu open={menu} onClose={() => setMenu(false)}>
              <PopoverMenuItem label="one" onClick={() => {}} />
            </PopoverMenu>
          </div>
        </Modal>
      );
    }
    render(<WithMenu />);
    await user.click(screen.getByText("more"));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "one" })).toHaveFocus());

    await user.keyboard("{Escape}");
    // The menu stays mounted while it fades out; closed means inert.
    expect(screen.getByRole("menu", { hidden: true })).toHaveAttribute("inert");
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("more")).toHaveFocus());
  });
});

describe("dialog launched from a menu item", () => {
  function MenuLaunchesModal({ autoFocusChild = false }: { autoFocusChild?: boolean }) {
    const [menu, setMenu] = useState(false);
    const [modal, setModal] = useState(false);
    return (
      <div className="relative">
        <button onClick={() => setMenu((o) => !o)}>account</button>
        <PopoverMenu open={menu} onClose={() => setMenu(false)}>
          <PopoverMenuItem
            label="Add account"
            onClick={() => {
              setMenu(false);
              setModal(true);
            }}
          />
        </PopoverMenu>
        <Modal open={modal} onClose={() => setModal(false)} label="Add account">
          <button>first</button>
          {autoFocusChild && <input aria-label="key" autoFocus />}
        </Modal>
      </div>
    );
  }

  it.each([
    ["without autoFocus", false],
    ["with an autoFocus child", true],
  ])("returns focus to the menu's trigger, not the (now inert) menu item: %s", async (_name, autoFocusChild) => {
    const user = userEvent.setup();
    render(<MenuLaunchesModal autoFocusChild={autoFocusChild} />);
    const trigger = screen.getByText("account");
    trigger.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Add account" })).toHaveFocus());
    await user.keyboard("{Enter}");

    const dialog = screen.getByRole("dialog", { name: "Add account" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe("ConfirmDialog", () => {
  const base = { open: true, title: "Delete space?", body: "This cannot be undone.", confirmLabel: "Delete" };

  it("is one alertdialog named by its title and described by its body", () => {
    render(<ConfirmDialog {...base} onConfirm={() => {}} onClose={() => {}} />);
    const dialog = screen.getByRole("alertdialog", { name: "Delete space?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog).toHaveAccessibleDescription("This cannot be undone.");
    // No dialog nested inside another dialog.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dialog.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
  });

  it("puts first focus on Cancel, the safe choice", async () => {
    render(<ConfirmDialog {...base} danger onConfirm={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
  });

  it("runs the action and closes on Enter on the confirm button", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmDialog {...base} onConfirm={onConfirm} onClose={onClose} />);
    await user.tab();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("announces a failed action and stays open", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        {...base}
        onConfirm={() => Promise.reject(new Error("relay rejected it"))}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("relay rejected it");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores Escape while the action is running", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    let finish!: () => void;
    render(
      <ConfirmDialog
        {...base}
        onConfirm={() => new Promise<void>((resolve) => (finish = resolve))}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("button", { name: "Working…" })).toHaveAttribute("aria-busy", "true");
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
