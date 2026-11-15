import { describe, it, expect } from "vitest";
import { FIRST_ITEM_BASE, nextFirstItemIndex, tailAppended, type PrependState } from "../prependShift";

const state = (keys: string[], firstItemIndex = FIRST_ITEM_BASE): PrependState => ({ keys, firstItemIndex });

describe("nextFirstItemIndex", () => {
  it("starts at the base for a first render or an empty list", () => {
    expect(nextFirstItemIndex(null, ["a", "b"])).toBe(FIRST_ITEM_BASE);
    expect(nextFirstItemIndex(state([]), ["a"])).toBe(FIRST_ITEM_BASE);
    expect(nextFirstItemIndex(state(["a"]), [])).toBe(FIRST_ITEM_BASE);
  });

  it("does not move when rows are only appended", () => {
    expect(nextFirstItemIndex(state(["a", "b"]), ["a", "b", "c", "d"])).toBe(FIRST_ITEM_BASE);
  });

  it("goes down by the number of rows added above the old first row", () => {
    expect(nextFirstItemIndex(state(["c", "d"]), ["a", "b", "c", "d"])).toBe(FIRST_ITEM_BASE - 2);
  });

  it("accumulates across successive history pages", () => {
    let s = state(["m3"]);
    const page1 = ["m2", "m3"];
    s = state(page1, nextFirstItemIndex(s, page1));
    const page2 = ["m0", "m1", "m2", "m3", "m4"];
    s = state(page2, nextFirstItemIndex(s, page2));
    expect(s.firstItemIndex).toBe(FIRST_ITEM_BASE - 3);
  });

  it("counts only rows above the anchor when rows arrive at both ends", () => {
    expect(nextFirstItemIndex(state(["b", "c"]), ["a", "b", "c", "d", "e"])).toBe(FIRST_ITEM_BASE - 1);
  });

  it("ignores a row inserted in the middle", () => {
    expect(nextFirstItemIndex(state(["a", "c"]), ["a", "b", "c"])).toBe(FIRST_ITEM_BASE);
  });

  it("goes up when rows at the head are removed", () => {
    expect(nextFirstItemIndex(state(["a", "b", "c"], 500), ["b", "c"])).toBe(501);
    expect(nextFirstItemIndex(state(["a", "b", "c"], 500), ["c"])).toBe(502);
  });

  it("handles a removed head together with a prepend", () => {
    // "a" deleted, "x" and "y" arrive above "b": b moves from index 1 to 2.
    expect(nextFirstItemIndex(state(["a", "b", "c"], 500), ["x", "y", "b", "c"])).toBe(499);
  });

  it("restarts for a list that shares no row with the previous one", () => {
    expect(nextFirstItemIndex(state(["a", "b"], 42), ["x", "y"])).toBe(FIRST_ITEM_BASE);
  });

  it("never returns a negative index", () => {
    expect(nextFirstItemIndex(state(["z"], 1), ["a", "b", "c", "z"])).toBe(FIRST_ITEM_BASE);
  });
});

describe("tailAppended", () => {
  it("is true when the last row is new", () => {
    expect(tailAppended(["a"], ["a", "b"])).toBe(true);
    expect(tailAppended([], ["a"])).toBe(true);
  });

  it("is false for history added at the head", () => {
    expect(tailAppended(["c", "d"], ["a", "b", "c", "d"])).toBe(false);
  });

  it("is false for edits, middle inserts and an unchanged list", () => {
    expect(tailAppended(["a", "c"], ["a", "b", "c"])).toBe(false);
    expect(tailAppended(["a", "b"], ["a", "b"])).toBe(false);
  });

  it("is false when the old tail was deleted and an older row is now last", () => {
    expect(tailAppended(["a", "b", "c"], ["a", "b"])).toBe(false);
  });

  it("is true when a pending row is replaced by its confirmed copy at the tail", () => {
    expect(tailAppended(["a", "temp_1"], ["a", "evt_1"])).toBe(true);
  });

  it("is false for an empty list", () => {
    expect(tailAppended(["a"], [])).toBe(false);
  });
});
