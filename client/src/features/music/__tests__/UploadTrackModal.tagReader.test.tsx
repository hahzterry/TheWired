/**
 * The upload form when the tag reader cannot be downloaded: it says the file's
 * tags were not read, keeps working from the filename, and reads them on
 * "Try again". Before, it carried on as if the file had no tags.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { login } from "@/store/slices/identitySlice";

const reader = vi.hoisted(() => ({
  /** While true, importing the reader fails like a chunk that did not download. */
  offline: false,
  parseBlob: vi.fn(),
}));

vi.mock("music-metadata", () => {
  if (reader.offline) throw new TypeError("Importing a module script failed.");
  return { parseBlob: (...args: unknown[]) => reader.parseBlob(...args) };
});
// Nothing in these tests should reach a relay (the form looks up the uploader's profile).
vi.mock("@/features/profile/useProfile", () => ({ useProfile: () => ({ profile: null }) }));

import { UploadTrackModal } from "../UploadTrackModal";

const ME = "e".repeat(64);
const mp3 = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: "audio/mpeg" });

function pickAudio(file: File) {
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"][accept*=".mp3"]')!;
  fireEvent.change(input, { target: { files: [file] } });
}

function renderModal() {
  const view = renderWithProviders(<UploadTrackModal open onClose={() => {}} />);
  act(() => {
    view.store.dispatch(login({ pubkey: ME, signerType: "nip07" }));
  });
  return view;
}

beforeEach(() => {
  reader.offline = false;
  reader.parseBlob.mockReset();
  reader.parseBlob.mockResolvedValue({
    common: { title: "Night Drive (Remaster)", artist: "Luna Vega", genre: ["Synthwave"] },
    format: { duration: 201 },
  });
});

// The failing case runs first: once the reader has loaded in this file it
// stays loaded.
describe("UploadTrackModal and the tag reader", () => {
  it("says the tags were not read, fills in from the filename, and reads them on Try again", async () => {
    reader.offline = true;
    renderModal();

    pickAudio(mp3("Luna - Night Drive.mp3"));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(/tags .*couldn't be read/i);
    expect(notice).toHaveTextContent(/check your connection/i);
    expect(notice).toHaveTextContent(/reload the app/i);
    expect(reader.parseBlob).not.toHaveBeenCalled();
    // The form is still usable: the filename gave a title and an artist.
    const title = screen.getByDisplayValue("Night Drive");
    const artist = screen.getByDisplayValue("Luna");

    // Still offline: trying again lands back on the notice.
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // The user fixes the artist by hand while waiting.
    fireEvent.change(artist, { target: { value: "Luna V." } });

    // Back online: the tags are read. The title was only the filename's guess
    // and is replaced; the artist is the user's own text and is kept.
    reader.offline = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(reader.parseBlob).toHaveBeenCalledTimes(1);
    expect(title).toHaveValue("Night Drive (Remaster)");
    expect(artist).toHaveValue("Luna V.");
  });

  it("a file the reader cannot parse is not a load failure: filename fallback, no notice", async () => {
    reader.parseBlob.mockRejectedValueOnce(new Error("Guessed MIME-type not supported"));
    renderModal();

    pickAudio(mp3("Luna - Coast.mp3"));

    expect(await screen.findByDisplayValue("Coast")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Luna")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("with the reader working, the tags fill the form", async () => {
    renderModal();

    pickAudio(mp3("track01.mp3"));

    expect(await screen.findByDisplayValue("Night Drive (Remaster)")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Luna Vega")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
