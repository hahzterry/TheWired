import { describe, it, expect, beforeEach } from "vitest";
import {
  initialHeightEstimates,
  peekItemHeight,
  rememberItemHeight,
  resetItemHeightsForTests,
} from "../itemHeights";

beforeEach(() => resetItemHeightsForTests());

describe("item height memory", () => {
  it("remembers a measured height per scope and id", () => {
    rememberItemHeight("notes", "a", 312.4);
    expect(peekItemHeight("notes", "a")).toBe(312);
    expect(peekItemHeight("profile", "a")).toBeUndefined();
  });

  it("ignores zero and negative measurements", () => {
    rememberItemHeight("notes", "a", 0);
    rememberItemHeight("notes", "b", -4);
    expect(peekItemHeight("notes", "a")).toBeUndefined();
    expect(peekItemHeight("notes", "b")).toBeUndefined();
  });

  it("builds estimates from what was measured, falling back for the rest", () => {
    rememberItemHeight("notes", "b", 400);
    expect(initialHeightEstimates("notes", ["a", "b", "c"], 220)).toEqual([220, 400, 220]);
  });

  it("returns nothing when no row was ever measured", () => {
    expect(initialHeightEstimates("notes", ["a", "b"], 220)).toBeUndefined();
    expect(initialHeightEstimates("notes", [], 220)).toBeUndefined();
  });
});
