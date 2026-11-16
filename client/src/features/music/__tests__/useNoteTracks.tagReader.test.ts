/**
 * Audio attached to a note when the tag reader cannot be downloaded: the
 * draft keeps its filename title and the composer says the details were not
 * read. It used to say nothing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const reader = vi.hoisted(() => ({
  offline: false,
  parseBlob: vi.fn(),
}));

vi.mock("music-metadata", () => {
  if (reader.offline) throw new TypeError("Importing a module script failed.");
  return { parseBlob: (...args: unknown[]) => reader.parseBlob(...args) };
});
vi.mock("../noteTrack", () => ({ MAX_NOTE_TRACKS: 3, publishNoteTrack: vi.fn() }));

import { NOTE_TRACK_TAGS_UNREAD, useNoteTracks } from "../useNoteTracks";

const mp3 = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: "audio/mpeg" });

beforeEach(() => {
  reader.offline = false;
  reader.parseBlob.mockReset();
  reader.parseBlob.mockResolvedValue({ common: { title: "Night Drive" }, format: { duration: 201 } });
});

describe("useNoteTracks and the tag reader", () => {
  it("keeps the filename title and says the details were not read", async () => {
    reader.offline = true;
    const { result } = renderHook(() => useNoteTracks());

    act(() => result.current.addFiles([mp3("demo take 3.mp3")]));

    await waitFor(() => expect(result.current.notice).toBe(NOTE_TRACK_TAGS_UNREAD));
    expect(NOTE_TRACK_TAGS_UNREAD).toMatch(/check your connection/i);
    expect(NOTE_TRACK_TAGS_UNREAD).toMatch(/add it again/i);
    expect(result.current.drafts).toHaveLength(1);
    expect(result.current.drafts[0].title).toBe("demo take 3");
    expect(result.current.drafts[0].duration).toBeUndefined();
  });

  it("removing the track and adding it again reads the tags once the reader loads", async () => {
    reader.offline = true;
    const { result } = renderHook(() => useNoteTracks());
    act(() => result.current.addFiles([mp3("demo take 3.mp3")]));
    await waitFor(() => expect(result.current.notice).toBe(NOTE_TRACK_TAGS_UNREAD));

    reader.offline = false;
    act(() => result.current.remove(result.current.drafts[0].id));
    expect(result.current.notice).toBeNull();
    act(() => result.current.addFiles([mp3("demo take 3.mp3")]));

    await waitFor(() => expect(result.current.drafts[0]?.title).toBe("Night Drive"));
    expect(result.current.drafts[0].duration).toBe(201);
    expect(result.current.notice).toBeNull();
  });

  it("a file the reader cannot parse stays silent", async () => {
    reader.parseBlob.mockRejectedValueOnce(new Error("unsupported"));
    const { result } = renderHook(() => useNoteTracks());

    act(() => result.current.addFiles([mp3("odd.mp3")]));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(result.current.notice).toBeNull();
    expect(result.current.drafts[0].title).toBe("odd");
  });
});
