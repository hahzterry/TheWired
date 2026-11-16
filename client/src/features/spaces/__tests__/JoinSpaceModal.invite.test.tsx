import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";

// The join dialog checks the space a server resolves an invite code to
// against the space the link names, before and after redeeming.

const api = vi.hoisted(() => ({ preview: vi.fn(), redeem: vi.fn(), join: vi.fn() }));
vi.mock("@/lib/api/invites", () => ({
  getInviteWithPreview: (...a: unknown[]) => api.preview(...a),
  redeemInvite: (...a: unknown[]) => api.redeem(...a),
}));
vi.mock("../useSpace", () => ({ useSpace: () => ({ joinSpace: api.join }) }));

import { store, resetAll } from "@/store";
import { login } from "@/store/slices/identitySlice";
import { JoinSpaceModal } from "../JoinSpaceModal";

const ME = "a".repeat(64);
const LINKED = "e2e1-" + "1234abcd".repeat(4);
const OTHER = "e2e1-" + "9".repeat(32);

function preview(spaceId: string) {
  return {
    data: {
      code: "Ab3dEf9h",
      spaceId,
      createdBy: "b".repeat(64),
      space: { name: "Night Shift", memberCount: 3 },
    },
  };
}

function open(initialCode: string) {
  render(
    <Provider store={store}>
      <MemoryRouter>
        <JoinSpaceModal open onClose={() => {}} initialCode={initialCode} />
      </MemoryRouter>
    </Provider>,
  );
}

beforeEach(() => {
  store.dispatch(resetAll());
  store.dispatch(login({ pubkey: ME, signerType: "nip07" }));
  api.preview.mockReset();
  api.redeem.mockReset();
  api.join.mockReset();
});

describe("JoinSpaceModal: the invite names its space", () => {
  it("refuses when the server resolves the code to a different space, and never redeems it", async () => {
    api.preview.mockResolvedValue(preview(OTHER));
    open(`/invite/Ab3dEf9h/${LINKED}`);
    expect((await screen.findByText(/doesn't lead to the space it was made for/i)).textContent).toBeTruthy();
    expect(api.redeem).not.toHaveBeenCalled();
    expect(api.join).not.toHaveBeenCalled();
  });

  it("refuses an old link (no space in it) to an encrypted space", async () => {
    api.preview.mockResolvedValue(preview(LINKED));
    open("Ab3dEf9h");
    expect(await screen.findByText(/can't be checked/i)).toBeTruthy();
    expect(api.redeem).not.toHaveBeenCalled();
  });

  it("joins the space the link names", async () => {
    api.preview.mockResolvedValue(preview(LINKED));
    api.redeem.mockResolvedValue({ data: { spaceId: LINKED, space: { name: "Night Shift", mode: "read-write" } } });
    open(`/invite/Ab3dEf9h/${LINKED}`);
    fireEvent.click(await screen.findByRole("button", { name: /join/i }));
    await waitFor(() => expect(api.join).toHaveBeenCalled());
    expect(api.join.mock.calls[0][0]).toMatchObject({ id: LINKED });
  });

  it("refuses when the redeem answers with another space than the preview did", async () => {
    api.preview.mockResolvedValue(preview(LINKED));
    api.redeem.mockResolvedValue({ data: { spaceId: OTHER, space: { name: "Night Shift" } } });
    open(`/invite/Ab3dEf9h/${LINKED}`);
    fireEvent.click(await screen.findByRole("button", { name: /join/i }));
    expect(await screen.findByText(/doesn't lead to the space it was made for/i)).toBeTruthy();
    expect(api.join).not.toHaveBeenCalled();
  });

  it("keeps old links working for plain spaces", async () => {
    api.preview.mockResolvedValue(preview("a1b2c3d4e5f6"));
    api.redeem.mockResolvedValue({ data: { spaceId: "a1b2c3d4e5f6", space: { name: "Plain" } } });
    open("Ab3dEf9h");
    fireEvent.click(await screen.findByRole("button", { name: /join/i }));
    await waitFor(() => expect(api.join).toHaveBeenCalled());
  });
});
