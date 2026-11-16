import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";

// The link the invite dialog hands out (docs/E2EE_SPACES.md §5.4): an
// encrypted space's link names the space, every other space's link keeps the
// short `/invite/<code>` form that older clients route.

const api = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../../../lib/api/invites", () => ({
  createInvite: (...a: unknown[]) => api.create(...a),
}));

import { store, resetAll } from "@/store";
import { login } from "@/store/slices/identitySlice";
import { PUBLIC_WEB_ORIGIN } from "@/lib/publicLinks";
import { InviteGenerateModal } from "../InviteGenerateModal";

const ME = "a".repeat(64);
const PLAIN = "a1b2c3d4e5f6";
const ENCRYPTED = "e2e1-" + "1234abcd".repeat(4);

async function generateFor(spaceId: string): Promise<string> {
  render(
    <Provider store={store}>
      <MemoryRouter>
        <InviteGenerateModal open onClose={() => {}} spaceId={spaceId} spaceName="Night Shift" />
      </MemoryRouter>
    </Provider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
  const field = (await screen.findByDisplayValue(/\/invite\//)) as HTMLInputElement;
  return field.value;
}

beforeEach(() => {
  store.dispatch(resetAll());
  store.dispatch(login({ pubkey: ME, signerType: "nip07" }));
  api.create.mockReset();
  api.create.mockResolvedValue({ data: { code: "Ab3dEf9h" } });
});

describe("InviteGenerateModal: the link it hands out", () => {
  it("is the short form for a space that is not encrypted", async () => {
    expect(await generateFor(PLAIN)).toBe(`${PUBLIC_WEB_ORIGIN}/invite/Ab3dEf9h`);
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ spaceId: PLAIN }));
  });

  it("names the space for an encrypted space", async () => {
    expect(await generateFor(ENCRYPTED)).toBe(`${PUBLIC_WEB_ORIGIN}/invite/Ab3dEf9h/${ENCRYPTED}`);
  });
});
