import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toggle } from "../Toggle";
import { ColorPicker } from "../ColorPicker";
import { Spinner } from "../Spinner";
import { Avatar } from "../Avatar";
import { BlockedMessage } from "../BlockedMessage";
import { Button } from "../Button";
import { ShimmerButton } from "../ShimmerButton";
import { RevealSentinel } from "../RevealSentinel";

describe("Toggle", () => {
  function Harness() {
    const [on, setOn] = useState(false);
    return <Toggle label="Read receipts" description="Let others see when you read" checked={on} onChange={setOn} />;
  }

  it("is a named switch, described by its help text", () => {
    render(<Harness />);
    const toggle = screen.getByRole("switch", { name: "Read receipts" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription("Let others see when you read");
    expect(toggle).toHaveAttribute("type", "button");
  });

  it("has no dangling description reference without help text", () => {
    render(<Toggle label="Sounds" checked onChange={() => {}} />);
    expect(screen.getByRole("switch", { name: "Sounds" })).not.toHaveAttribute("aria-describedby");
  });

  it("flips with Space and Enter from the keyboard", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveFocus();
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});

describe("ColorPicker", () => {
  it("ties each slider to its label inside a group named by the picker label", () => {
    render(<ColorPicker label="Accent" value="220 14% 8%" onChange={() => {}} />);
    expect(screen.getByRole("group", { name: "Accent" })).toBeTruthy();
    const hue = screen.getByRole("slider", { name: "Hue" });
    expect(hue).toHaveAttribute("aria-valuetext", "220°");
    expect(screen.getByRole("slider", { name: "Saturation" })).toHaveAttribute("aria-valuetext", "14%");
    expect(screen.getByRole("slider", { name: "Lightness" })).toHaveAttribute("aria-valuetext", "8%");
  });

  it("gives two pickers on one page distinct ids", () => {
    const { container } = render(
      <>
        <ColorPicker label="Accent" value="220 14% 8%" onChange={() => {}} />
        <ColorPicker label="Background" value="0 0% 0%" onChange={() => {}} />
      </>,
    );
    const ids = Array.from(container.querySelectorAll("[id]")).map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(screen.getAllByRole("slider", { name: "Hue" })).toHaveLength(2);
  });

  it("reports changes made with the arrow keys' underlying input event", () => {
    const onChange = vi.fn();
    render(<ColorPicker label="Accent" value="220 14% 8%" onChange={onChange} />);
    const hue = screen.getByRole("slider", { name: "Hue" }) as HTMLInputElement;
    // jsdom does not move range inputs on arrow keys; drive the change event.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(hue, "221");
    hue.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith("221 14% 8%");
    expect(hue).toHaveAttribute("aria-valuetext", "221°");
  });
});

describe("Spinner", () => {
  it("is a status whose text content says Loading (text is what a live region announces)", () => {
    render(<Spinner />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading");
    expect(status).not.toHaveAttribute("aria-label");
    // The text is visually hidden, so the spinner looks the same.
    expect(status.querySelector("span")).toHaveClass("sr-only");
  });

  it("takes a specific label", () => {
    render(<Spinner label="Sending" />);
    expect(screen.getByRole("status")).toHaveTextContent("Sending");
  });

  it('is hidden from assistive tech with label=""', () => {
    const { container } = render(<Spinner label="" />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container.firstElementChild).toBeEmptyDOMElement();
  });

  it("keeps its size and caller classes on the one element", () => {
    const { container } = render(<Spinner size="lg" className="text-red-500" />);
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild).toHaveClass("h-8", "w-8", "animate-spin", "text-red-500");
  });
});

describe("Avatar", () => {
  it("gives the placeholder the same text alternative as the image", () => {
    const { rerender } = render(<Avatar src="https://example.test/a.png" alt="Luna Vega" />);
    expect(screen.getByRole("img", { name: "Luna Vega" }).tagName).toBe("IMG");
    rerender(<Avatar alt="Luna Vega" />);
    expect(screen.getByRole("img", { name: "Luna Vega" }).tagName).toBe("DIV");
  });

  it("keeps the default alternative when no alt is passed", () => {
    render(<Avatar />);
    expect(screen.getByRole("img", { name: "avatar" })).toBeTruthy();
  });

  it('hides a decorative placeholder (alt="")', () => {
    const { container } = render(<Avatar alt="" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });
});

describe("BlockedMessage", () => {
  it.each(["chat", "note", "reply"] as const)("%s: reveal and hide from the keyboard", async (variant) => {
    const user = userEvent.setup();
    const onUnblock = vi.fn();
    render(
      <BlockedMessage variant={variant} onUnblock={onUnblock}>
        <p>secret text</p>
      </BlockedMessage>,
    );
    expect(screen.queryByText("secret text")).toBeNull();
    await user.tab();
    const show = screen.getByRole("button", { name: "Show" });
    expect(show).toHaveFocus();
    // Hidden until hover: keyboard focus must make it visible too.
    expect(show.className).toContain("focus-visible:opacity-100");
    await user.keyboard("{Enter}");
    expect(screen.getByText("secret text")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Unblock user" }));
    expect(onUnblock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText("secret text")).toBeNull();
  });

  it("buttons do not submit a surrounding form", () => {
    render(
      <BlockedMessage variant="chat">
        <p>x</p>
      </BlockedMessage>,
    );
    expect(screen.getByRole("button", { name: "Show" })).toHaveAttribute("type", "button");
  });
});

describe("Button / ShimmerButton / RevealSentinel", () => {
  it("Button forwards aria-label for icon-only use and disabled state", () => {
    render(
      <Button aria-label="Close" disabled>
        <svg aria-hidden="true" />
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Close" });
    expect(button).toBeDisabled();
    expect(button.className).toContain("focus-visible:ring-2");
  });

  it("ShimmerButton's name is its label only: decorative layers are hidden", () => {
    render(<ShimmerButton>Get started</ShimmerButton>);
    const button = screen.getByRole("button", { name: "Get started" });
    const layers = Array.from(button.children).filter((el) => el.tagName === "DIV");
    expect(layers).toHaveLength(3);
    for (const layer of layers) expect(layer).toHaveAttribute("aria-hidden", "true");
  });

  it("RevealSentinel is hidden from assistive tech", () => {
    const { container } = render(<RevealSentinel onReach={() => {}} />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });
});
