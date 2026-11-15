import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useState, type ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Modal } from "../Modal";
import { ModalBoundary } from "../ModalBoundary";
import { withModalBoundary } from "../withModalBoundary";
import { getCrashRecords, resetCrashLogForTests } from "@/lib/crash/crashLog";

const bomb = { explode: true };

/** A modal whose own render throws, before it ever reaches `<Modal>`. */
function OwnerThrowsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (open && bomb.explode) throw new Error("modal owner exploded");
  return (
    <Modal open={open} onClose={onClose}>
      <div data-testid="modal-body">
        modal body <button onClick={onClose}>done</button>
      </div>
    </Modal>
  );
}

/** A modal whose content throws from inside the dialog. */
function ChildThrowsModal({ onClose }: { onClose: () => void }) {
  function Body(): ReactElement {
    if (bomb.explode) throw new Error("modal child exploded");
    return <div data-testid="modal-body">modal body</div>;
  }
  return (
    <Modal open onClose={onClose}>
      <Body />
    </Modal>
  );
}

const BoundedOwner = withModalBoundary(OwnerThrowsModal, "owner-throws");
const BoundedChild = withModalBoundary(ChildThrowsModal, "child-throws");

function App({ which }: { which: "owner" | "child" }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div data-testid="page">page behind the modal</div>
      <button onClick={() => setOpen(true)}>open modal</button>
      {which === "owner" ? (
        <BoundedOwner open={open} onClose={() => setOpen(false)} />
      ) : (
        open && <BoundedChild onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

describe("ModalBoundary", () => {
  beforeEach(() => {
    bomb.explode = true;
    localStorage.clear();
    resetCrashLogForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["owner", "child"] as const)(
    "a throwing modal (%s render) can be dismissed and leaves the page mounted",
    (which) => {
      render(<App which={which} />);
      fireEvent.click(screen.getByText("open modal"));

      const fallback = screen.getByRole("alert");
      expect(fallback).toHaveTextContent("This dialog hit a problem");
      expect(fallback).toHaveAttribute("data-boundary-fallback", "modal");
      expect(screen.getByTestId("page")).toBeInTheDocument();
      expect(getCrashRecords()[0].boundary).toBe(`modal:${which}-throws`);

      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByTestId("page")).toBeInTheDocument();
    },
  );

  it("can be dismissed with Escape, like any modal", () => {
    render(<App which="child" />);
    fireEvent.click(screen.getByText("open modal"));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reopening after a dismissal gets a fresh attempt", () => {
    render(<App which="owner" />);
    fireEvent.click(screen.getByText("open modal"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    bomb.explode = false;
    fireEvent.click(screen.getByText("open modal"));
    expect(screen.getByTestId("modal-body")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("try again recovers in place once the cause is gone", () => {
    render(<App which="child" />);
    fireEvent.click(screen.getByText("open modal"));
    bomb.explode = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(screen.getByTestId("modal-body")).toBeInTheDocument();
  });

  it("a closed modal that throws shows nothing", () => {
    function AlwaysThrows(_props: { open: boolean; onClose: () => void }): never {
      throw new Error("throws even when closed");
    }
    const Bounded = withModalBoundary(AlwaysThrows, "always-throws");
    const { container } = render(<Bounded open={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays dismissed when the owner keeps a broken modal mounted", () => {
    function AlwaysThrows(_props: { onClose: () => void }): never {
      throw new Error("no open flag, always mounted");
    }
    const Bounded = withModalBoundary(AlwaysThrows, "always-mounted");
    const onClose = vi.fn();
    render(<Bounded onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("contained mode renders the card without opening a second dialog", () => {
    function Body(): never {
      throw new Error("inner exploded");
    }
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose}>
        <ModalBoundary contained label="inner" onClose={onClose}>
          <Body />
        </ModalBoundary>
      </Modal>,
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the app's modals are exported behind the boundary", async () => {
    const [{ FollowListModal }, { ZapListModal }, { NewDMModal }] = await Promise.all([
      import("@/features/profile/FollowListModal"),
      import("@/features/wallet/ZapListModal"),
      import("@/features/dm/NewDMModal"),
    ]);
    expect(FollowListModal.displayName).toBe("ModalBoundary(follow-list)");
    expect(ZapListModal.displayName).toBe("ModalBoundary(zap-list)");
    expect(NewDMModal.displayName).toBe("ModalBoundary(new-dm)");
  });
});
