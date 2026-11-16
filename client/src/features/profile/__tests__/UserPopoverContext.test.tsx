import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { getCrashRecords, resetCrashLogForTests } from "@/lib/crash/crashLog";

const card = vi.hoisted(() => ({ explode: false }));

vi.mock("../UserPopoverCard", () => ({
  UserPopoverCard: ({ pubkey, onClose }: { pubkey: string; onClose: () => void }) => {
    if (card.explode) throw new Error("popover card exploded");
    return (
      <div data-testid="popover">
        {pubkey} <button onClick={onClose}>close popover</button>
      </div>
    );
  },
}));

import { UserPopoverProvider, useUserPopover } from "../UserPopoverContext";

const ALICE = "a".repeat(64);

function Avatar() {
  const { openUserPopover } = useUserPopover();
  return <button onClick={(e) => openUserPopover(ALICE, e.currentTarget)}>avatar</button>;
}

function renderApp() {
  return renderWithProviders(
    <UserPopoverProvider>
      <div data-testid="shell">shell</div>
      <Avatar />
    </UserPopoverProvider>,
  );
}

describe("UserPopoverProvider error containment", () => {
  beforeEach(() => {
    card.explode = false;
    localStorage.clear();
    resetCrashLogForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a popover that throws shows nothing and leaves the shell mounted", () => {
    card.explode = true;
    renderApp();
    fireEvent.click(screen.getByText("avatar"));
    expect(screen.queryByTestId("popover")).toBeNull();
    expect(screen.getByTestId("shell")).toBeInTheDocument();
    expect(getCrashRecords()[0].boundary).toBe("overlay:user-popover");
  });

  it("clicking the same avatar again retries, without needing a navigation", () => {
    card.explode = true;
    renderApp();
    fireEvent.click(screen.getByText("avatar"));
    expect(screen.queryByTestId("popover")).toBeNull();

    // Same pubkey, same anchor element: only the open itself is new.
    card.explode = false;
    fireEvent.click(screen.getByText("avatar"));
    expect(screen.getByTestId("popover")).toHaveTextContent(ALICE);
  });

  it("still fails closed on a second open if the cause is still there", () => {
    card.explode = true;
    renderApp();
    fireEvent.click(screen.getByText("avatar"));
    fireEvent.click(screen.getByText("avatar"));
    expect(screen.queryByTestId("popover")).toBeNull();
    expect(screen.getByTestId("shell")).toBeInTheDocument();
    expect(getCrashRecords()).toHaveLength(1);
    expect(getCrashRecords()[0].count).toBe(2);
  });

  it("opens and closes normally when nothing throws", () => {
    renderApp();
    fireEvent.click(screen.getByText("avatar"));
    expect(screen.getByTestId("popover")).toBeInTheDocument();
    fireEvent.click(screen.getByText("close popover"));
    expect(screen.queryByTestId("popover")).toBeNull();
  });
});
