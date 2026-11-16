/**
 * The replace-audio form when the tag reader cannot be downloaded: it says the
 * new file's length was not read and offers to try again, where it used to
 * carry on silently with the old length.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { login } from "@/store/slices/identitySlice";
import type { MusicTrack } from "@/types/music";

const reader = vi.hoisted(() => ({
  offline: false,
  parseBlob: vi.fn(),
}));

vi.mock("music-metadata", () => {
  if (reader.offline) throw new TypeError("Failed to fetch dynamically imported module: /assets/music-metadata-abc.js");
  return { parseBlob: (...args: unknown[]) => reader.parseBlob(...args) };
});
// Nothing in these tests should reach a relay (the form looks up the uploader's profile).
vi.mock("@/features/profile/useProfile", () => ({ useProfile: () => ({ profile: null }) }));

import { ReplaceAudioModal } from "../ReplaceAudioModal";

const ME = "e".repeat(64);

const track = {
  addressableId: `31683:${ME}:night-drive`,
  eventId: "1".repeat(64),
  pubkey: ME,
  title: "Night Drive",
  artist: "Luna",
  artistPubkeys: [],
  featuredArtists: [],
  collaborators: [],
  duration: 180,
  hashtags: [],
  variants: [{ url: "https://cdn.example/night-drive.mp3", mimeType: "audio/mpeg" }],
  createdAt: 1,
  spaceIds: [],
  visibility: "public",
} as unknown as MusicTrack;

function pickAudio(file: File) {
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  reader.offline = false;
  reader.parseBlob.mockReset();
  reader.parseBlob.mockResolvedValue({ common: {}, format: { duration: 245 } });
});

describe("ReplaceAudioModal and the tag reader", () => {
  it("says the length was not read and reads it on Try again", async () => {
    reader.offline = true;
    const { store } = renderWithProviders(<ReplaceAudioModal track={track} onClose={() => {}} />);
    act(() => {
      store.dispatch(login({ pubkey: ME, signerType: "nip07" }));
    });

    pickAudio(new File([new Uint8Array([1])], "night-drive-v2.mp3", { type: "audio/mpeg" }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(/length couldn't be read/i);
    expect(notice).toHaveTextContent(/check your connection/i);
    expect(screen.queryByText(/Duration will change/)).toBeNull();

    reader.offline = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("Duration will change from 3:00 to 4:05")).toBeInTheDocument();
  });
});
