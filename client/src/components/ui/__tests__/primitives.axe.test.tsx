/**
 * axe-core pass over every shared primitive, in each state that changes its
 * markup. Behaviour (keyboard, focus) lives in the per-component tests; this
 * file answers "does the rendered markup violate a WCAG rule axe can check".
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { useRef, useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { expectNoAxeViolations, axeViolationIds } from "@/__tests__/helpers/axe";

vi.mock("@/lib/media/uploadPlan", () => ({ uploadWithContext: vi.fn() }));

import { AnchoredPopover } from "../AnchoredPopover";
import { Avatar } from "../Avatar";
import { BlockedMessage } from "../BlockedMessage";
import { Button } from "../Button";
import { ColorPicker } from "../ColorPicker";
import { ConfirmDialog } from "../ConfirmDialog";
import { ImageUpload } from "../ImageUpload";
import { ModalLoading, PanelLoading } from "../LazyFallbacks";
import { MagicCard } from "../MagicCard";
import { MediaLightbox } from "../MediaLightbox";
import { Modal, ModalTitle } from "../Modal";
import { PopoverMenu, PopoverMenuItem, PopoverMenuSeparator } from "../PopoverMenu";
import { RevealSentinel } from "../RevealSentinel";
import { ShimmerButton } from "../ShimmerButton";
import { Spinner } from "../Spinner";
import { TextAnimate } from "../TextAnimate";
import { Toggle } from "../Toggle";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe("the axe helper itself", () => {
  it("catches an icon-only button without a name (the check can fail)", async () => {
    render(
      <button>
        <svg aria-hidden="true" />
      </button>,
    );
    expect(await axeViolationIds()).toContain("button-name");
    await expect(expectNoAxeViolations()).rejects.toThrow();
  });

  it("catches an unnamed dialog and an unlabelled input", async () => {
    render(
      <div role="dialog" aria-modal="true">
        <input type="text" />
      </div>,
    );
    const ids = await axeViolationIds();
    expect(ids).toContain("aria-dialog-name");
    expect(ids).toContain("label");
  });
});

describe("axe: dialogs", () => {
  it("Modal named by its title", async () => {
    render(
      <Modal open onClose={() => {}}>
        <div>
          <ModalTitle>Create space</ModalTitle>
          <label htmlFor="n">Name</label>
          <input id="n" />
          <button>Create</button>
        </div>
      </Modal>,
    );
    await screen.findByRole("dialog", { name: "Create space" });
    await expectNoAxeViolations();
  });

  it("the loading and error dialogs that have no visible title are named too", async () => {
    render(<ModalLoading onClose={() => {}} delayMs={0} />);
    expect(screen.getByRole("dialog", { name: "Loading" })).toBeTruthy();
    await expectNoAxeViolations();
  });

  it("Modal with an explicit label", async () => {
    render(
      <Modal open onClose={() => {}} label="Image options">
        <button>Done</button>
      </Modal>,
    );
    await expectNoAxeViolations();
  });

  it("ConfirmDialog, idle and with an error", async () => {
    render(
      <ConfirmDialog
        open
        danger
        title="Delete space?"
        body="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => Promise.reject(new Error("nope"))}
        onClose={() => {}}
      />,
    );
    await expectNoAxeViolations();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("alert");
    await expectNoAxeViolations();
  });

  it("MediaLightbox, single image and zoomed gallery", async () => {
    const { unmount } = render(<MediaLightbox src="https://example.test/a.png" alt="A cat" onClose={() => {}} />);
    await expectNoAxeViolations();
    unmount();

    render(
      <MediaLightbox
        srcs={["https://example.test/a.png", "https://example.test/b.png", "https://example.test/c.png"]}
        startIndex={1}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await expectNoAxeViolations();
  });
});

describe("axe: menus and popovers", () => {
  function Menu({ open, mixed = false }: { open: boolean; mixed?: boolean }) {
    const ref = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={ref} aria-haspopup="menu" aria-expanded={open}>
          More
        </button>
        <PopoverMenu open={open} onClose={() => {}} anchorRef={ref} label="Message actions">
          {mixed && <input aria-label="Reason" />}
          <PopoverMenuItem label="Copy text" onClick={() => {}} />
          <PopoverMenuSeparator />
          <PopoverMenuItem label="Delete" variant="danger" onClick={() => {}} />
        </PopoverMenu>
      </>
    );
  }

  it("PopoverMenu open (role=menu)", async () => {
    render(<Menu open />);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Copy text" })).toHaveFocus());
    await expectNoAxeViolations();
  });

  it("PopoverMenu open with mixed content (plain container)", async () => {
    render(<Menu open mixed />);
    await expectNoAxeViolations();
  });

  it("PopoverMenu closed (inert)", async () => {
    render(<Menu open={false} />);
    await expectNoAxeViolations();
  });

  it("AnchoredPopover with a role and label", async () => {
    function Popup() {
      const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
      return (
        <>
          <button ref={setAnchor}>Emoji</button>
          <AnchoredPopover anchorEl={anchor} open onClose={() => {}} role="dialog" label="Emoji picker">
            <button>smile</button>
          </AnchoredPopover>
        </>
      );
    }
    render(<Popup />);
    expect(await screen.findByRole("dialog", { name: "Emoji picker" })).toBeTruthy();
    await expectNoAxeViolations();
  });
});

describe("axe: form primitives", () => {
  it("Toggle, on and off, with and without description", async () => {
    render(
      <>
        <Toggle label="Read receipts" description="Let others see when you read" checked onChange={() => {}} />
        <Toggle label="Sounds" checked={false} onChange={() => {}} />
      </>,
    );
    await expectNoAxeViolations();
  });

  it("ColorPicker", async () => {
    render(<ColorPicker label="Accent" value="220 14% 8%" onChange={() => {}} />);
    await expectNoAxeViolations();
  });

  it("ImageUpload: empty, with a preview, URL mode, and without a label", async () => {
    const { unmount } = render(
      <ImageUpload value="" onChange={() => {}} context={"public" as never} label="Space icon" />,
    );
    await expectNoAxeViolations();
    fireEvent.click(screen.getByRole("button", { name: "Paste URL" }));
    await expectNoAxeViolations();
    unmount();

    const second = render(
      <ImageUpload
        value="https://example.test/icon.png"
        onChange={() => {}}
        context={"public" as never}
        label="Space icon"
        shape="circle"
      />,
    );
    await expectNoAxeViolations();
    second.unmount();

    render(<ImageUpload value="" onChange={() => {}} context={"public" as never} />);
    await expectNoAxeViolations();
  });

  it("Button variants and an icon-only Button with a label", async () => {
    render(
      <>
        <Button>Save</Button>
        <Button variant="secondary" disabled>
          Cancel
        </Button>
        <Button variant="ghost" aria-label="Close">
          <svg aria-hidden="true" />
        </Button>
        <ShimmerButton>Get started</ShimmerButton>
      </>,
    );
    await expectNoAxeViolations();
  });
});

describe("axe: display primitives", () => {
  it("Avatar: image, placeholder, decorative", async () => {
    render(
      <>
        <Avatar src="https://example.test/a.png" alt="Luna Vega" />
        <Avatar alt="Marcus Cole" />
        <Avatar alt="" />
        <Avatar />
      </>,
    );
    await expectNoAxeViolations();
  });

  it("Spinner: labelled and silent", async () => {
    render(
      <>
        <PanelLoading label="Loading settings" delayMs={0} />
        <Spinner />
        <Spinner size="sm" label="Sending" />
        <Spinner label="" />
      </>,
    );
    await expectNoAxeViolations();
  });

  it("BlockedMessage: hidden and revealed, every variant", async () => {
    for (const variant of ["chat", "note", "reply"] as const) {
      const { unmount } = render(
        <BlockedMessage variant={variant} onUnblock={() => {}}>
          <p>secret text</p>
        </BlockedMessage>,
      );
      await expectNoAxeViolations();
      fireEvent.click(screen.getByRole("button", { name: "Show" }));
      await expectNoAxeViolations();
      unmount();
    }
  });

  it("MagicCard, RevealSentinel and TextAnimate", async () => {
    render(
      <>
        <MagicCard>
          <p>Card body</p>
        </MagicCard>
        <RevealSentinel onReach={() => {}} />
        <TextAnimate as="h2" by="character">
          Welcome
        </TextAnimate>
      </>,
    );
    await expectNoAxeViolations();
  });
});
