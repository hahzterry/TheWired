/**
 * The tag reader is downloaded when a file is first picked. A download that
 * fails must not look like a file without tags.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const reader = vi.hoisted(() => ({
  /** While true, importing the reader fails like a chunk that did not download. */
  offline: false,
  imports: 0,
  parseBlob: vi.fn(),
}));

vi.mock("music-metadata", () => {
  reader.imports += 1;
  if (reader.offline) throw new TypeError("Failed to fetch dynamically imported module: /assets/music-metadata-abc.js");
  return { parseBlob: (...args: unknown[]) => reader.parseBlob(...args) };
});

import { parseTrackFiles, readAudioMetadata } from "../trackFileParser";
import { isTagReaderLoadError, TAG_READER_LOAD_MESSAGE, TagReaderLoadError } from "../tagReaderError";

const mp3 = (name = "01 - Night Drive.mp3") => new File([new Uint8Array([1, 2, 3])], name, { type: "audio/mpeg" });

beforeEach(() => {
  reader.offline = false;
  reader.parseBlob.mockReset();
  reader.parseBlob.mockResolvedValue({
    common: { title: "Night Drive", artist: "Luna", album: "Roads", genre: ["Synthwave"], year: 2024, track: { no: 1 }, disk: { no: 1 } },
    format: { duration: 201.5 },
  });
});

// Order matters in this file: the reader is a module, and once it has loaded
// it stays loaded, so the cases where it cannot be downloaded come first.
describe("readAudioMetadata when the tag reader cannot be downloaded", () => {
  it("rejects with TagReaderLoadError (a sentence for the user), not an empty result", async () => {
    reader.offline = true;

    const failure = await readAudioMetadata(mp3()).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(TagReaderLoadError);
    expect((failure as Error).message).toBe(TAG_READER_LOAD_MESSAGE);
    expect(isTagReaderLoadError(failure)).toBe(true);
    expect(reader.parseBlob).not.toHaveBeenCalled();
  });

  it("a batch rejects too, so the album form does not continue with untagged tracks", async () => {
    reader.offline = true;
    await expect(parseTrackFiles([mp3("a.mp3"), mp3("b.mp3")])).rejects.toBeInstanceOf(TagReaderLoadError);
  });

  it("does not keep the failure: the next read downloads again and returns the tags", async () => {
    reader.offline = true;
    await expect(readAudioMetadata(mp3())).rejects.toBeInstanceOf(TagReaderLoadError);
    const importsWhileOffline = reader.imports;

    reader.offline = false;
    const meta = await readAudioMetadata(mp3());

    expect(reader.imports).toBeGreaterThan(importsWhileOffline);
    expect(meta).toMatchObject({ title: "Night Drive", artist: "Luna", album: "Roads", genre: "Synthwave", year: "2024", trackNumber: 1, duration: 201.5 });
  });
});

describe("readAudioMetadata once the reader has loaded", () => {
  it("a file the reader cannot parse still yields an empty result, as before", async () => {
    reader.parseBlob.mockRejectedValueOnce(new Error("Guessed MIME-type not supported"));
    await expect(readAudioMetadata(mp3("broken.mp3"))).resolves.toEqual({});
  });

  it("a format parser that cannot be downloaded mid-parse is a load failure too, not an empty result", async () => {
    // The reader imports the parser for the file's format while it parses.
    for (const message of [
      "Failed to fetch dynamically imported module: /assets/MpegParser-abc.js",
      "Importing a module script failed.",
      "error loading dynamically imported module",
    ]) {
      reader.parseBlob.mockRejectedValueOnce(new TypeError(message));
      await expect(readAudioMetadata(mp3())).rejects.toBeInstanceOf(TagReaderLoadError);
    }
    // And the next read, with the parser available, works.
    await expect(readAudioMetadata(mp3())).resolves.toMatchObject({ title: "Night Drive" });
  });

  it("a batch falls back to filenames for files without tags", async () => {
    reader.parseBlob.mockRejectedValue(new Error("unsupported"));
    const [track] = await parseTrackFiles([mp3("03 - Coast.mp3")]);
    expect(track.title).toBe("Coast");
    expect(track.trackNumber).toBe(3);
    expect(track.hasId3).toBe(false);
  });
});

describe("isTagReaderLoadError", () => {
  it("recognises a raw failed-chunk error and nothing else", () => {
    expect(isTagReaderLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isTagReaderLoadError(new Error("unsupported"))).toBe(false);
    expect(isTagReaderLoadError(undefined)).toBe(false);
  });
});
