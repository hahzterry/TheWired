import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MediaLightbox } from "../MediaLightbox";
import { Modal } from "../Modal";

const SRCS = ["https://example.test/a.png", "https://example.test/b.png", "https://example.test/c.png"];

function Thumb({ gallery = false }: { gallery?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>thumbnail</button>
      {open &&
        (gallery ? (
          <MediaLightbox srcs={SRCS} onClose={() => setOpen(false)} />
        ) : (
          <MediaLightbox src={SRCS[0]} alt="A cat on a desk" onClose={() => setOpen(false)} />
        ))}
    </>
  );
}

describe("MediaLightbox semantics", () => {
  it("is a modal dialog named after the image", () => {
    render(<MediaLightbox src={SRCS[0]} alt="A cat on a desk" onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "A cat on a desk" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("falls back to a generic name without alt text", () => {
    const { unmount } = render(<MediaLightbox src={SRCS[0]} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Image viewer" })).toBeTruthy();
    unmount();
    render(<MediaLightbox srcs={SRCS} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Image gallery" })).toBeTruthy();
  });

  it("names every icon-only control", () => {
    render(<MediaLightbox srcs={SRCS} startIndex={1} onClose={() => {}} />);
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Download", "Zoom in", "Zoom out", "Close", "Previous image", "Next image"]);
    for (const button of screen.getAllByRole("button")) expect(button).toHaveAttribute("type", "button");
  });

  it("announces the position in a gallery", async () => {
    const user = userEvent.setup();
    render(<MediaLightbox srcs={SRCS} onClose={() => {}} />);
    expect(screen.getByText("Image 1 of 3")).toBeTruthy();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("Image 2 of 3")).toBeTruthy();
  });

  it("exposes the zoom level once zoomed", async () => {
    const user = userEvent.setup();
    render(<MediaLightbox src={SRCS[0]} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("status", { name: "Zoom 150%" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset zoom" })).toBeTruthy();
  });
});

describe("MediaLightbox keyboard journey", () => {
  it("puts first focus on Close, traps Tab, and returns focus to the thumbnail on Escape", async () => {
    const user = userEvent.setup();
    render(<Thumb />);
    const thumb = screen.getByText("thumbnail");
    thumb.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.tab(); // last control → wraps to the first
    expect(screen.getByRole("button", { name: "Download" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    expect(thumb).not.toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(thumb).toHaveFocus();
  });

  it("closes with Enter on the Close button", async () => {
    const user = userEvent.setup();
    render(<Thumb />);
    await user.click(screen.getByText("thumbnail"));
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Tab inside after a gallery edge removes the focused arrow", async () => {
    const user = userEvent.setup();
    render(<MediaLightbox srcs={SRCS.slice(0, 2)} onClose={() => {}} />);
    const next = screen.getByRole("button", { name: "Next image" });
    next.focus();
    await user.keyboard("{Enter}"); // last image: the Next button unmounts
    expect(screen.queryByRole("button", { name: "Next image" })).toBeNull();
    await user.tab();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    expect(document.body).not.toHaveFocus();
  });

  it("Escape closes the viewer but not the dialog underneath", async () => {
    const user = userEvent.setup();
    const onModalClose = vi.fn();
    render(
      <Modal open onClose={onModalClose} label="Profile">
        <Thumb />
      </Modal>,
    );
    await user.click(screen.getByText("thumbnail"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "A cat on a desk" })).toBeNull();
    expect(onModalClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Profile" })).toBeTruthy();
  });
});

describe("MediaLightbox pointer behaviour", () => {
  it("closes on a press on the backdrop, not on the image or the controls", () => {
    const onClose = vi.fn();
    render(<MediaLightbox src={SRCS[0]} alt="cat" onClose={onClose} />);
    fireEvent.mouseDown(screen.getByAltText("cat"));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Zoom in" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("dialog").querySelector('[role="presentation"]')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("locks body scroll while open and restores it", () => {
    document.body.style.overflow = "auto";
    const { unmount } = render(<MediaLightbox src={SRCS[0]} onClose={() => {}} />);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
    document.body.style.overflow = "";
  });
});
