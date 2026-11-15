import { describe, it, expect } from "vitest";
import type { SpaceEpochInfo } from "@ishtarservices/shared-types";
import { epochsToGrant, planKeyReconcile } from "../keyReconcile";

const ME = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function epoch(id: string, seq: number): SpaceEpochInfo {
  return { id, seq, prev: null, managers: [ME], history: "epoch", at: 1, grantedBy: ME };
}

describe("planKeyReconcile", () => {
  it("does nothing when roster and key holders agree", () => {
    expect(planKeyReconcile([ME, B], [ME, B], ME)).toEqual({ grantTo: [], rotate: false });
  });

  it("hands the key to roster members who lack it", () => {
    expect(planKeyReconcile([ME, B, C], [ME], ME)).toEqual({ grantTo: [B, C], rotate: false });
  });

  it("rotates when a holder is no longer on the roster", () => {
    expect(planKeyReconcile([ME, B], [ME, B, C], ME)).toEqual({ grantTo: [], rotate: true });
  });

  it("rotates (covering the newcomer too) when someone left and someone joined", () => {
    expect(planKeyReconcile([ME, C], [ME, B], ME)).toEqual({ grantTo: [], rotate: true });
  });

  it("does not act on a roster that omits the manager (stale or partial)", () => {
    expect(planKeyReconcile([], [ME, B], ME)).toEqual({ grantTo: [], rotate: false });
    expect(planKeyReconcile([B], [ME, B], ME)).toEqual({ grantTo: [], rotate: false });
  });
});

describe("epochsToGrant", () => {
  const held = [epoch("bb", 1), epoch("aa", 0), epoch("cc", 2)];

  it("'epoch' hands over the current epoch only", () => {
    expect(epochsToGrant("epoch", held).map((e) => e.id)).toEqual(["cc"]);
  });

  it("'full' hands over every epoch, oldest first", () => {
    expect(epochsToGrant("full", held).map((e) => e.id)).toEqual(["aa", "bb", "cc"]);
  });

  it("picks the same epoch senders use on a tie", () => {
    expect(epochsToGrant("epoch", [epoch("bb", 3), epoch("aa", 3)]).map((e) => e.id)).toEqual(["aa"]);
  });

  it("hands over nothing when nothing is held", () => {
    expect(epochsToGrant("full", [])).toEqual([]);
  });
});
