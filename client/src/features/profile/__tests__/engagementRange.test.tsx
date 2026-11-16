/**
 * Engagement driven by a virtualized list's rendered range (instead of one
 * IntersectionObserver per card).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@/lib/nostr/subscriptionManager", () => ({
  subscriptionManager: { subscribe: vi.fn(), close: vi.fn() },
}));

import { subscriptionManager } from "@/lib/nostr/subscriptionManager";
import { EngagementWindow, useEngagementRange } from "../engagementCollector";
import { engagementSubs, noteIds } from "./engagementSubs";

const subscribe = vi.mocked(subscriptionManager.subscribe);
const close = vi.mocked(subscriptionManager.close);
const subs = engagementSubs(subscribe as unknown as Mock, close as unknown as Mock);

beforeEach(() => {
  vi.useFakeTimers();
  subscribe.mockReset();
  close.mockReset();
  let n = 0;
  subscribe.mockImplementation(() => `sub-${++n}`);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EngagementWindow.setVisible", () => {
  it("fetches the rendered range once, in feed order, and follows it live", () => {
    const w = new EngagementWindow(["wss://r"]);
    w.setVisible(["n10", "n11", "n12"], 10);
    w.flush();
    expect(subs.stored().map(noteIds)).toEqual([["n10", "n11", "n12"]]);
    expect(subs.live().map(noteIds)).toEqual([["n10", "n11", "n12"]]);
    w.dispose();
  });

  it("fetches only the notes that are new to the window as it moves, and keeps the rest live", () => {
    const w = new EngagementWindow();
    w.setVisible(["a", "b", "c"], 0);
    w.flush();
    w.setVisible(["b", "c", "d", "e"], 1);
    w.flush();
    expect(subs.stored().map(noteIds)).toEqual([["a", "b", "c"], ["d", "e"]]);
    // `b` and `c` are still rendered: they are still subscribed to.
    expect(noteIds(subs.openLive()!)).toEqual(["b", "c", "d", "e"]);
    w.dispose();
  });

  it("drops rows that left the window before the debounce fired", () => {
    const w = new EngagementWindow(undefined, 300);
    // A fling: three ranges inside one debounce window.
    w.setVisible(["a", "b"], 0);
    w.setVisible(["m", "n"], 40);
    w.setVisible(["y", "z"], 90);
    vi.advanceTimersByTime(300);
    expect(subs.stored().map(noteIds)).toEqual([["y", "z"]]);
    expect(subs.live().map(noteIds)).toEqual([["y", "z"]]);
    w.dispose();
  });

  it("does not re-fetch when the window scrolls back over fetched notes, but follows them again", () => {
    const w = new EngagementWindow();
    w.setVisible(["a", "b"], 0);
    w.flush();
    w.setVisible(["c", "d"], 2);
    w.flush();
    w.setVisible(["a", "b"], 0);
    w.flush();
    expect(subs.stored().map(noteIds)).toEqual([["a", "b"], ["c", "d"]]);
    expect(noteIds(subs.openLive()!)).toEqual(["a", "b"]);
    w.dispose();
  });
});

describe("useEngagementRange", () => {
  it("reports a range to a window bound to the given relays", () => {
    const { result } = renderHook(() => useEngagementRange(["wss://host"], "chan-1"));
    result.current(["a", "b"], 0);
    vi.advanceTimersByTime(300);
    expect(subs.all().map(noteIds)).toEqual([["a", "b"], ["a", "b"]]);
    expect(subs.all().map((r) => r.relayUrls)).toEqual([["wss://host"], ["wss://host"]]);
  });

  it("keeps the same window while only the relay array identity changes", () => {
    const { result, rerender } = renderHook(({ urls }) => useEngagementRange(urls, "chan-1"), {
      initialProps: { urls: ["wss://host"] },
    });
    result.current(["a"], 0);
    vi.advanceTimersByTime(300);
    rerender({ urls: ["wss://host"] });
    result.current(["a"], 0);
    vi.advanceTimersByTime(300);
    // Already fetched and followed by the same window: nothing new, nothing closed.
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
  });

  it("starts over when the feed changes: closes what was open and fetches again", () => {
    const { result, rerender } = renderHook(({ key }) => useEngagementRange(undefined, key), {
      initialProps: { key: "chan-1" },
    });
    result.current(["a"], 0);
    vi.advanceTimersByTime(300);
    rerender({ key: "chan-2" });
    expect(subs.open()).toEqual([]);
    result.current(["a"], 0);
    vi.advanceTimersByTime(300);
    expect(subs.stored().map(noteIds)).toEqual([["a"], ["a"]]);
  });

  it("closes its subscriptions on unmount", () => {
    const { result, unmount } = renderHook(() => useEngagementRange(undefined, "chan-1"));
    result.current(["a"], 0);
    vi.advanceTimersByTime(300);
    expect(subs.open()).toHaveLength(2);
    unmount();
    expect(subs.open()).toEqual([]);
  });
});
