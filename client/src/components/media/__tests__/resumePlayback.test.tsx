/**
 * An inline player in a virtualized list is unmounted when its card scrolls
 * far enough away, and mounted again (a new element) when it comes back.
 * Playback stops; the position must not be lost.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { createTestStore } from "@/__tests__/helpers/createTestStore";
import { identitySlice } from "@/store/slices/identitySlice";
import { resetRetainedStateForTests } from "@/hooks/useRetainedState";
import { SmartVideo } from "../SmartVideo";
import { InlineAudio } from "../InlineAudio";

const VIDEO = "https://media.example/clip.mp4";
const AUDIO = "https://media.example/voice.mp3";
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

/** jsdom's media elements do not play: give one a duration and a position. */
function asLoaded<T extends HTMLMediaElement>(el: T, duration = 120): T {
  Object.defineProperty(el, "duration", { value: duration, configurable: true });
  Object.defineProperty(el, "currentTime", { value: el.currentTime || 0, writable: true, configurable: true });
  fireEvent.loadedMetadata(el);
  return el;
}

/** The reader plays it up to `seconds`. */
function playTo(el: HTMLMediaElement, seconds: number) {
  fireEvent.play(el);
  el.currentTime = seconds;
  fireEvent.timeUpdate(el);
}

function signedIn(pubkey: string) {
  const store = createTestStore();
  store.dispatch(identitySlice.actions.login({ pubkey, signerType: "nip07" }));
  return store;
}

let play: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetRetainedStateForTests();
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
});
afterEach(() => vi.restoreAllMocks());

describe("inline video that is unmounted and mounted again", () => {
  const mount = (store = signedIn(ALICE), url = VIDEO) => {
    const view = renderWithProviders(<SmartVideo url={url} poster="https://media.example/poster.jpg" />, { store });
    return { ...view, video: view.container.querySelector("video")! };
  };

  it("comes back at the position it was left at, paused", () => {
    const store = signedIn(ALICE);
    const first = mount(store);
    playTo(asLoaded(first.video), 42);
    first.unmount(); // the card scrolls out of the rendered window

    play.mockClear();
    const second = mount(store); // and back in: a new element
    expect(second.video).not.toBe(first.video);
    asLoaded(second.video);
    expect(second.video.currentTime).toBe(42);
    // Nothing starts playing on its own when a card scrolls into view.
    expect(play).not.toHaveBeenCalled();
  });

  it("keeps following the position as playback goes on, and after a seek", () => {
    const store = signedIn(ALICE);
    const first = mount(store);
    playTo(asLoaded(first.video), 10);
    playTo(first.video, 75);
    first.video.currentTime = 30; // seeks back
    fireEvent.timeUpdate(first.video);
    first.unmount();
    expect(asLoaded(mount(store).video).currentTime).toBe(30);
  });

  it("starts from the beginning when it was never played", () => {
    const store = signedIn(ALICE);
    const first = mount(store);
    asLoaded(first.video);
    first.unmount();
    expect(asLoaded(mount(store).video).currentTime).toBe(0);
  });

  it("starts over after it was played to the end", () => {
    const store = signedIn(ALICE);
    const first = mount(store);
    playTo(asLoaded(first.video), 119.8);
    fireEvent.ended(first.video);
    first.unmount();
    expect(asLoaded(mount(store).video).currentTime).toBe(0);
  });

  it("starts over when the reader took it back to the start", () => {
    const store = signedIn(ALICE);
    const first = mount(store);
    playTo(asLoaded(first.video), 50);
    first.video.currentTime = 0;
    fireEvent.timeUpdate(first.video);
    first.unmount();
    expect(asLoaded(mount(store).video).currentTime).toBe(0);
  });

  it("does not jump to a position past the end of shorter media under the same address", () => {
    const store = signedIn(ALICE);
    const first = mount(store);
    playTo(asLoaded(first.video, 120), 100);
    first.unmount();
    expect(asLoaded(mount(store).video, 60).currentTime).toBe(0);
  });

  it("leaves a live stream alone (it has no position to come back to)", () => {
    const store = signedIn(ALICE);
    const first = mount(store);
    playTo(asLoaded(first.video, Infinity), 500);
    first.unmount();
    expect(asLoaded(mount(store).video, Infinity).currentTime).toBe(0);
  });

  it("is the same media when only its access grant changed", () => {
    const store = signedIn(ALICE);
    const first = mount(store, `${VIDEO}?tk=old-grant`);
    playTo(asLoaded(first.video), 42);
    first.unmount();
    expect(asLoaded(mount(store, `${VIDEO}?tk=new-grant`).video).currentTime).toBe(42);
  });

  it("keeps positions apart by media and by account", () => {
    const first = mount(signedIn(ALICE));
    playTo(asLoaded(first.video), 42);
    first.unmount();
    expect(asLoaded(mount(signedIn(ALICE), "https://media.example/other.mp4").video).currentTime).toBe(0);
    expect(asLoaded(mount(signedIn(BOB)).video).currentTime).toBe(0);
    expect(asLoaded(mount(signedIn(ALICE)).video).currentTime).toBe(42);
  });

  it("a chat video comes back on its place with the play button, and plays on from there", () => {
    const store = signedIn(ALICE);
    const chat = () => {
      const view = renderWithProviders(<SmartVideo url={VIDEO} density="chat" />, { store });
      return { ...view, video: view.container.querySelector("video")! };
    };
    const first = chat();
    playTo(asLoaded(first.video), 42);
    first.unmount();

    play.mockClear();
    const second = chat();
    asLoaded(second.video);
    expect(second.video.currentTime).toBe(42);
    expect(play).not.toHaveBeenCalled();
    act(() => void fireEvent.click(second.getByRole("button", { name: "Play video" })));
    expect(play).toHaveBeenCalledTimes(1);
    expect(second.video.currentTime).toBe(42);
  });
});

describe("inline audio that is unmounted and mounted again", () => {
  const mount = (store = signedIn(ALICE)) => {
    const view = renderWithProviders(<InlineAudio src={AUDIO} />, { store });
    return { ...view, audio: view.container.querySelector("audio")! };
  };

  it("comes back at the position it was left at, paused", () => {
    const store = signedIn(ALICE);
    const first = mount(store);
    playTo(asLoaded(first.audio, 300), 187);
    first.unmount();
    play.mockClear();
    expect(asLoaded(mount(store).audio, 300).currentTime).toBe(187);
    expect(play).not.toHaveBeenCalled();
  });

  it("renders the same native player as before", () => {
    const { audio } = mount();
    expect(audio.getAttribute("src")).toBe(AUDIO);
    expect(audio.controls).toBe(true);
    expect(audio.preload).toBe("metadata");
  });
});
