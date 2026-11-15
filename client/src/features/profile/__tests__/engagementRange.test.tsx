/**
 * Engagement driven by a virtualized list's rendered range (instead of one
 * IntersectionObserver per card).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@/lib/nostr/subscriptionManager", () => ({
  subscriptionManager: { subscribe: vi.fn(), close: vi.fn() },
}));

import { subscriptionManager } from "@/lib/nostr/subscriptionManager";
import { EngagementWindow, useEngagementRange } from "../engagementCollector";

const subscribe = vi.mocked(subscriptionManager.subscribe);
const close = vi.mocked(subscriptionManager.close);

function eIds(callIndex: number): string[] {
  return (subscribe.mock.calls[callIndex][0] as { filters: { "#e": string[] }[] }).filters[0]["#e"];
}
function relays(callIndex: number): string[] | undefined {
  return (subscribe.mock.calls[callIndex][0] as { relayUrls?: string[] }).relayUrls;
}

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
  it("fetches the rendered range once, in feed order", () => {
    const w = new EngagementWindow(["wss://r"]);
    w.setVisible(["n10", "n11", "n12"], 10);
    w.flush();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(eIds(0)).toEqual(["n10", "n11", "n12"]);
    w.dispose();
  });

  it("fetches only the notes that are new to the window as it moves", () => {
    const w = new EngagementWindow();
    w.setVisible(["a", "b", "c"], 0);
    w.flush();
    w.setVisible(["b", "c", "d", "e"], 1);
    w.flush();
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(eIds(1)).toEqual(["d", "e"]);
    // Only the newest batch stays live.
    expect(close).toHaveBeenCalledWith("sub-1");
    w.dispose();
  });

  it("drops rows that left the window before the debounce fired", () => {
    const w = new EngagementWindow(undefined, 300);
    // A fling: three ranges inside one debounce window.
    w.setVisible(["a", "b"], 0);
    w.setVisible(["m", "n"], 40);
    w.setVisible(["y", "z"], 90);
    vi.advanceTimersByTime(300);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(eIds(0)).toEqual(["y", "z"]);
    w.dispose();
  });

  it("does not re-fetch when the window scrolls back over fetched notes", () => {
    const w = new EngagementWindow();
    w.setVisible(["a", "b"], 0);
    w.flush();
    w.setVisible(["c", "d"], 2);
    w.flush();
    w.setVisible(["a", "b"], 0);
    w.flush();
    expect(subscribe).toHaveBeenCalledTimes(2);
    w.dispose();
  });
});

describe("useEngagementRange", () => {
  it("reports a range to a window bound to the given relays", () => {
    const { result } = renderHook(() => useEngagementRange(["wss://host"], "chan-1"));
    result.current(["a", "b"], 0);
    vi.advanceTimersByTime(300);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(eIds(0)).toEqual(["a", "b"]);
    expect(relays(0)).toEqual(["wss://host"]);
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
    // Already fetched by the same window: no second REQ, nothing closed.
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("starts over when the feed changes: closes the old sub and fetches again", () => {
    const { result, rerender } = renderHook(({ key }) => useEngagementRange(undefined, key), {
      initialProps: { key: "chan-1" },
    });
    result.current(["a"], 0);
    vi.advanceTimersByTime(300);
    rerender({ key: "chan-2" });
    expect(close).toHaveBeenCalledWith("sub-1");
    result.current(["a"], 0);
    vi.advanceTimersByTime(300);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("closes its subscription on unmount", () => {
    const { result, unmount } = renderHook(() => useEngagementRange(undefined, "chan-1"));
    result.current(["a"], 0);
    vi.advanceTimersByTime(300);
    unmount();
    expect(close).toHaveBeenCalledWith("sub-1");
  });
});
