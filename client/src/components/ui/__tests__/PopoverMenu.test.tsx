import { describe, it, expect, vi } from "vitest";
import { useRef, useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PopoverMenu, PopoverMenuItem, PopoverMenuSeparator } from "../PopoverMenu";

function MenuHarness({ portal = true }: { portal?: boolean }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative">
      <button ref={triggerRef} onClick={() => setOpen((o) => !o)}>
        trigger
      </button>
      <PopoverMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={portal ? triggerRef : undefined}
        label="Actions"
      >
        <PopoverMenuItem label="one" onClick={() => {}} />
        <PopoverMenuItem label="two" onClick={() => {}} />
        <PopoverMenuSeparator />
        <PopoverMenuItem label="three" variant="danger" onClick={() => {}} />
      </PopoverMenu>
    </div>
  );
}

describe("PopoverMenu a11y", () => {
  it("focuses the first item on open", async () => {
    render(
      <PopoverMenu open onClose={() => {}}>
        <PopoverMenuItem label="one" onClick={() => {}} />
        <PopoverMenuItem label="two" onClick={() => {}} />
      </PopoverMenu>,
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("one")));
  });

  it("roves focus with Arrow keys (wrapping) and Home/End", async () => {
    render(
      <PopoverMenu open onClose={() => {}}>
        <PopoverMenuItem label="one" onClick={() => {}} />
        <PopoverMenuItem label="two" onClick={() => {}} />
        <PopoverMenuItem label="three" onClick={() => {}} />
      </PopoverMenu>,
    );
    const one = screen.getByText("one");
    const two = screen.getByText("two");
    const three = screen.getByText("three");
    await waitFor(() => expect(document.activeElement).toBe(one));

    fireEvent.keyDown(one, { key: "ArrowDown" });
    expect(document.activeElement).toBe(two);

    fireEvent.keyDown(two, { key: "ArrowUp" });
    expect(document.activeElement).toBe(one);

    fireEvent.keyDown(one, { key: "ArrowUp" }); // wraps to last
    expect(document.activeElement).toBe(three);

    fireEvent.keyDown(three, { key: "Home" });
    expect(document.activeElement).toBe(one);

    fireEvent.keyDown(one, { key: "End" });
    expect(document.activeElement).toBe(three);
  });

  it("restores focus to the trigger on close", async () => {
    render(<MenuHarness />);
    const trigger = screen.getByText("trigger");
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("one")));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe("PopoverMenu roles", () => {
  it("is a named menu of menuitems when it holds only items and separators", async () => {
    render(
      <PopoverMenu open onClose={() => {}} label="Message actions">
        <PopoverMenuItem label="Copy" onClick={() => {}} />
        <>
          <PopoverMenuSeparator />
          {false}
          <PopoverMenuItem label="Delete" variant="danger" onClick={() => {}} />
        </>
      </PopoverMenu>,
    );
    const menu = screen.getByRole("menu", { name: "Message actions" });
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Copy", "Delete"]);
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
  });

  it("stays a plain container when it holds anything else (role=menu forbids it)", () => {
    render(
      <PopoverMenu open onClose={() => {}}>
        <input aria-label="Reason" />
        <PopoverMenuItem label="Ban" onClick={() => {}} />
        <PopoverMenuSeparator />
      </PopoverMenu>,
    );
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByRole("button", { name: "Ban" })).toBeTruthy();
  });

  it("is not a menu when it is empty", () => {
    render(
      <PopoverMenu open onClose={() => {}}>
        {null}
      </PopoverMenu>,
    );
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("items never submit a surrounding form", () => {
    render(
      <PopoverMenu open onClose={() => {}}>
        <PopoverMenuItem label="one" onClick={() => {}} />
      </PopoverMenu>,
    );
    expect(screen.getByRole("menuitem", { name: "one" })).toHaveAttribute("type", "button");
  });
});

describe("PopoverMenu while closed", () => {
  it.each([
    ["portal", true],
    ["inline", false],
  ])("is inert (%s mode): mounted for the fade-out, out of tab order and the a11y tree", async (_mode, portal) => {
    const user = userEvent.setup();
    render(<MenuHarness portal={portal} />);
    const menu = screen.getByRole("menu", { hidden: true });
    expect(menu).toHaveAttribute("inert");

    await user.click(screen.getByText("trigger"));
    expect(menu).not.toHaveAttribute("inert");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "one" })).toHaveFocus());

    await user.keyboard("{Escape}");
    expect(menu).toHaveAttribute("inert");
    await waitFor(() => expect(screen.getByText("trigger")).toHaveFocus());
  });
});

describe("PopoverMenu keyboard journey (real key presses)", () => {
  it("opens from the trigger, arrows through, activates with Enter", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    function Menu() {
      const [open, setOpen] = useState(false);
      return (
        <div className="relative">
          <button onClick={() => setOpen(true)}>trigger</button>
          <PopoverMenu open={open} onClose={() => setOpen(false)}>
            <PopoverMenuItem label="one" onClick={() => {}} />
            <PopoverMenuItem
              label="two"
              onClick={() => {
                onPick();
                setOpen(false);
              }}
            />
          </PopoverMenu>
        </div>
      );
    }
    render(<Menu />);
    screen.getByText("trigger").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "one" })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "two" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("trigger")).toHaveFocus());
  });

  it("leaves arrow keys alone inside a text field", async () => {
    const user = userEvent.setup();
    render(
      <PopoverMenu open onClose={() => {}}>
        <input aria-label="Reason" defaultValue="abc" />
        <PopoverMenuItem label="Ban" onClick={() => {}} />
      </PopoverMenu>,
    );
    const input = screen.getByLabelText("Reason");
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveFocus();
  });
});

describe("PopoverMenu pointer behaviour", () => {
  it("does not let clicks inside reach React ancestors (portal and inline)", () => {
    const onRowClick = vi.fn();
    for (const portal of [true, false]) {
      const { unmount } = render(
        <div onClick={onRowClick}>
          <Open portal={portal} />
        </div>,
      );
      fireEvent.click(screen.getByText("one"));
      fireEvent.click(screen.getByRole("menu"));
      unmount();
    }
    expect(onRowClick).not.toHaveBeenCalled();

    function Open({ portal }: { portal: boolean }) {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={ref}>t</button>
          <PopoverMenu open onClose={() => {}} anchorRef={portal ? ref : undefined}>
            <PopoverMenuItem label="one" onClick={() => {}} />
          </PopoverMenu>
        </>
      );
    }
  });

  it("closes on a press outside", () => {
    const onClose = vi.fn();
    render(
      <>
        <button>outside</button>
        <PopoverMenu open onClose={onClose}>
          <PopoverMenuItem label="one" onClick={() => {}} />
        </PopoverMenu>
      </>,
    );
    fireEvent.mouseDown(screen.getByText("one"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByText("outside"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
