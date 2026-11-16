import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

vi.mock("@/lib/nostr/subscriptionManager", () => ({
  subscriptionManager: { subscribe: vi.fn(), close: vi.fn() },
}));

import { subscriptionManager } from "@/lib/nostr/subscriptionManager";
import { EngagementWindow } from "../engagementCollector";
import { deletionTargets, engagementSubs, noteIds } from "./engagementSubs";

const subscribe = vi.mocked(subscriptionManager.subscribe);
const close = vi.mocked(subscriptionManager.close);
const subs = engagementSubs(subscribe as unknown as Mock, close as unknown as Mock);

const T0 = new Date("2026-01-01T00:00:00Z").getTime();
const nowS = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  subscribe.mockReset();
  close.mockReset();
  let n = 0;
  subscribe.mockImplementation(() => `sub-${++n}`);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EngagementWindow: stored engagement", () => {
  it("is fetched for visible notes in document order, one filter per kind", () => {
    const w = new EngagementWindow(["wss://r"]);
    w.report("b", 1, true);
    w.report("a", 0, true);
    w.flush();
    expect(subs.stored()).toHaveLength(1);
    expect(noteIds(subs.stored()[0])).toEqual(["a", "b"]); // sorted by feed index
    expect(subs.stored()[0].filters.map((f) => f.kinds)).toEqual([[7], [6], [1], [9735]]);
    expect(subs.stored()[0].filters.every((f) => f.since === undefined)).toBe(true);
    expect(subs.stored()[0].relayUrls).toEqual(["wss://r"]);
    w.dispose();
  });

  it("is fetched once per note while the visible set is unchanged", () => {
    const w = new EngagementWindow();
    w.report("a", 0, true);
    w.flush();
    w.report("a", 0, true); // still visible, already fetched
    w.flush();
    expect(subscribe).toHaveBeenCalledTimes(2); // one fetch, one live subscription
    expect(subs.stored()).toHaveLength(1);
    w.dispose();
  });

  it("asks only about newly revealed notes", () => {
    const w = new EngagementWindow();
    w.report("a", 0, true);
    w.flush();
    w.report("b", 1, true);
    w.flush();
    expect(subs.stored().map(noteIds)).toEqual([["a"], ["b"]]);
    w.dispose();
  });

  it("is never asked for again when a note scrolls out and back into view", () => {
    const w = new EngagementWindow();
    w.report("a", 0, true);
    w.flush();
    w.report("a", 0, false); // scrolled away
    w.flush();
    w.report("a", 0, true); // scrolled back
    w.flush();
    expect(subs.stored()).toHaveLength(1);
    w.dispose();
  });

  it("is a one-shot request: closed when the relays have answered, not when the window moves on", () => {
    const w = new EngagementWindow();
    w.report("a", 0, true);
    w.flush();
    const first = subs.stored()[0];
    // The window moves on before the relays answered.
    w.report("a", 0, false);
    w.report("b", 1, true);
    w.flush();
    expect(close).not.toHaveBeenCalledWith(first.subId);
    subs.eose(first);
    expect(close).toHaveBeenCalledWith(first.subId);
    w.dispose();
  });

  it("runs at most three fetches at once; the rest go out when one finishes", () => {
    const w = new EngagementWindow();
    for (let i = 0; i < 5; i++) {
      w.setVisible([`n${i}`], i);
      w.flush();
    }
    expect(subs.stored().map(noteIds)).toEqual([["n0"], ["n1"], ["n2"]]);
    // n4 is the note on screen; n3 was flung past and is not fetched.
    subs.eose(subs.stored()[0]);
    expect(subs.stored().map(noteIds)).toEqual([["n0"], ["n1"], ["n2"], ["n4"]]);
    w.dispose();
  });

  it("asks again later when the request never left the client", () => {
    const w = new EngagementWindow();
    w.report("a", 0, true);
    w.flush();
    subs.stored()[0].onEOSE?.({ reason: "no-relays", sentTo: 0 });
    w.report("a", 0, true);
    w.flush();
    expect(subs.stored().map(noteIds)).toEqual([["a"], ["a"]]);
    w.dispose();
  });
});

describe("EngagementWindow: live engagement", () => {
  it("covers every visible note with one subscription: all kinds since now, plus the un-react leg", () => {
    const w = new EngagementWindow(["wss://r"]);
    w.report("a", 0, true);
    w.report("b", 1, true);
    w.flush();
    const live = subs.openLive()!;
    expect(live.filters.map((f) => f.kinds)).toEqual([[7, 6, 1, 9735], [5]]);
    expect(noteIds(live)).toEqual(["a", "b"]);
    expect(live.filters[0].since).toBe(nowS() - 120);
    expect(live.relayUrls).toEqual(["wss://r"]);
    w.dispose();
  });

  it("keeps a note live for as long as it is visible, however many batches were fetched since", () => {
    const w = new EngagementWindow();
    w.setVisible(["a", "b", "c"], 0);
    w.flush();
    // The window moves by one row, three times. `c` stays on screen throughout.
    w.setVisible(["b", "c", "d"], 1);
    w.flush();
    expect(noteIds(subs.openLive()!)).toEqual(["b", "c", "d"]);
    w.setVisible(["c", "d", "e"], 2);
    w.flush();
    expect(noteIds(subs.openLive()!)).toEqual(["c", "d", "e"]);
    // Stored engagement was still only asked for once per note.
    expect(subs.stored().map(noteIds)).toEqual([["a", "b", "c"], ["d"], ["e"]]);
    w.dispose();
  });

  it("opens the replacement before closing the subscription it replaces", () => {
    const w = new EngagementWindow();
    w.setVisible(["a", "b"], 0);
    w.flush();
    const first = subs.openLive()!;
    w.setVisible(["b", "c"], 1);
    w.flush();
    const second = subs.openLive()!;
    const opened = subscribe.mock.invocationCallOrder[subs.all().findIndex((r) => r.subId === second.subId)];
    const closedAt = close.mock.invocationCallOrder[close.mock.calls.findIndex((c) => c[0] === first.subId)];
    expect(opened).toBeLessThan(closedAt);
    w.dispose();
  });

  it("does nothing while the visible set is unchanged", () => {
    const w = new EngagementWindow();
    w.setVisible(["a", "b"], 0);
    w.flush();
    w.setVisible(["a", "b"], 0);
    w.flush();
    expect(subs.live()).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
    w.dispose();
  });

  it("asks a note that comes back for what it missed while it was away", () => {
    const w = new EngagementWindow();
    w.setVisible(["a"], 0);
    w.flush();
    vi.setSystemTime(T0 + 60_000);
    w.setVisible(["z"], 25); // `a` leaves the window at T0 + 60 s
    w.flush();
    const leftAt = nowS();
    vi.setSystemTime(T0 + 3_600_000);
    w.setVisible(["a"], 0); // and is back an hour later
    w.flush();
    expect(subs.stored().map(noteIds)).toEqual([["a"], ["z"]]); // no second full fetch
    expect(subs.openLive()!.filters[0].since).toBe(leftAt - 120);
    w.dispose();
  });

  it("covers at most 100 notes, the first in feed order", () => {
    const w = new EngagementWindow();
    w.setVisible(
      Array.from({ length: 150 }, (_, i) => `n${i}`),
      0,
    );
    w.flush();
    expect(noteIds(subs.openLive()!)).toHaveLength(100);
    expect(noteIds(subs.openLive()!)[99]).toBe("n99");
    w.dispose();
  });

  it("never opens a subscription per note: one live, plus the fetches in flight", () => {
    const w = new EngagementWindow();
    for (let i = 0; i < 40; i++) {
      w.setVisible([`n${i}`, `n${i + 1}`, `n${i + 2}`], i);
      w.flush();
      expect(subs.open().length).toBeLessThanOrEqual(4);
    }
    w.dispose();
  });

  it("is closed when nothing is visible any more", () => {
    const w = new EngagementWindow();
    w.report("a", 0, true);
    w.flush();
    w.report("a", 0, false);
    w.flush();
    expect(subs.openLive()).toBeUndefined();
    w.dispose();
  });

  it("does nothing when no notes are visible", () => {
    const w = new EngagementWindow();
    w.flush();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("debounces multiple reports into a single flush", () => {
    const w = new EngagementWindow(undefined, 300);
    w.report("a", 0, true);
    w.report("b", 1, true);
    expect(subscribe).not.toHaveBeenCalled(); // timer not fired yet
    vi.advanceTimersByTime(300);
    expect(subs.stored().map(noteIds)).toEqual([["a", "b"]]);
    expect(subs.live().map(noteIds)).toEqual([["a", "b"]]);
    w.dispose();
  });
});

describe("EngagementWindow: un-reacts (kind:5)", () => {
  it("the leg unions note ids with the reaction ids already known for them", () => {
    const w = new EngagementWindow(["wss://r"], undefined, (ids) =>
      ids.flatMap((id) => (id === "a" ? ["rx-a1", "rx-a2"] : [])),
    );
    w.report("a", 0, true);
    w.report("b", 1, true);
    w.flush();
    const live = subs.openLive()!;
    expect(deletionTargets(live)).toEqual(["a", "b", "rx-a1", "rx-a2"]);
    // No `since`: a reaction that just became known may have been retracted long ago.
    expect(live.filters[1].since).toBeUndefined();
    // The engagement leg still targets only the notes.
    expect(noteIds(live)).toEqual(["a", "b"]);
    w.dispose();
  });

  it("is re-issued as soon as the stored reactions have arrived", () => {
    const known: string[] = [];
    const w = new EngagementWindow(undefined, undefined, () => known);
    w.report("a", 0, true);
    w.flush();
    expect(deletionTargets(subs.openLive()!)).toEqual(["a"]);
    // The fetch brings the note's reactions, then EOSE.
    known.push("rx-1", "rx-2");
    subs.eose(subs.stored()[0]);
    expect(deletionTargets(subs.openLive()!)).toEqual(["a", "rx-1", "rx-2"]);
    expect(subs.stored()).toHaveLength(1); // nothing is fetched again for it
    w.dispose();
  });

  it("is re-issued when a reaction arrives live on a note that stays on screen", () => {
    const known: string[] = [];
    const w = new EngagementWindow(undefined, undefined, () => known);
    w.report("a", 0, true);
    w.flush();
    subs.eose(subs.stored()[0]);
    expect(subs.live()).toHaveLength(1);

    vi.advanceTimersByTime(10_000); // nothing new: nothing re-issued
    expect(subs.live()).toHaveLength(1);

    known.push("rx-live"); // someone reacts
    vi.advanceTimersByTime(10_000);
    expect(subs.live()).toHaveLength(2);
    expect(deletionTargets(subs.openLive()!)).toEqual(["a", "rx-live"]);

    known.push("rx-later"); // and it keeps checking
    vi.advanceTimersByTime(10_000);
    expect(deletionTargets(subs.openLive()!)).toEqual(["a", "rx-live", "rx-later"]);
    w.dispose();
  });

  it("carries at most the 1000 newest known reaction ids", () => {
    const known = Array.from({ length: 1500 }, (_, i) => `rx-${i}`);
    const w = new EngagementWindow(undefined, undefined, () => known);
    w.report("a", 0, true);
    w.flush();
    const targets = deletionTargets(subs.openLive()!);
    expect(targets).toHaveLength(1001);
    expect(targets[1]).toBe("rx-500");
    w.dispose();
  });
});

describe("EngagementWindow: dispose", () => {
  it("closes everything it has open and stops checking", () => {
    const w = new EngagementWindow();
    w.report("a", 0, true);
    w.flush();
    w.dispose();
    expect(subs.open()).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("resets what was fetched: the same id is fetched again on a fresh cycle", () => {
    const w = new EngagementWindow();
    w.report("a", 0, true);
    w.flush();
    w.dispose();
    w.report("a", 0, true);
    w.flush();
    expect(subs.stored().map(noteIds)).toEqual([["a"], ["a"]]);
    w.dispose();
  });

  it("an answer that arrives after dispose opens nothing", () => {
    const known: string[] = [];
    const w = new EngagementWindow(undefined, undefined, () => known);
    w.report("a", 0, true);
    w.flush();
    const fetch = subs.stored()[0];
    w.dispose();
    known.push("rx-1");
    subs.eose(fetch);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });
});
