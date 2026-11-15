import { describe, it, expect } from "vitest";
import { isNearBottom, jumpBehavior, nextPinned, nextStuck, onListChange } from "../bottomPin";

describe("isNearBottom", () => {
  it("is true within the threshold of the end", () => {
    expect(isNearBottom({ scrollTop: 921, scrollHeight: 1500, clientHeight: 500 }, 80)).toBe(true);
    expect(isNearBottom({ scrollTop: 1000, scrollHeight: 1500, clientHeight: 500 }, 80)).toBe(true);
  });

  it("is false once the reader is further up than the threshold", () => {
    expect(isNearBottom({ scrollTop: 920, scrollHeight: 1500, clientHeight: 500 }, 80)).toBe(false);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 1500, clientHeight: 500 }, 80)).toBe(false);
  });

  it("is true for a list shorter than its viewport", () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 500 }, 60)).toBe(true);
  });
});

describe("onListChange", () => {
  it("follows a new row while the reader is at the bottom", () => {
    expect(onListChange({ ownSend: false, appended: true, atBottom: true })).toBe("follow");
  });

  it("keeps a reader in history where they are and raises the hint", () => {
    expect(onListChange({ ownSend: false, appended: true, atBottom: false })).toBe("hint");
  });

  it("always follows an own send, wherever the reader is", () => {
    expect(onListChange({ ownSend: true, appended: true, atBottom: false })).toBe("follow");
    expect(onListChange({ ownSend: true, appended: false, atBottom: false })).toBe("follow");
  });

  it("does nothing when nothing arrived at the tail (history, edit, deletion, divider fade)", () => {
    expect(onListChange({ ownSend: false, appended: false, atBottom: true })).toBe("stay");
    expect(onListChange({ ownSend: false, appended: false, atBottom: false })).toBe("stay");
  });
});

describe("jumpBehavior", () => {
  const rendered = { startIndex: 100, endIndex: 130 };

  it("animates a hop to a row in or near the rendered window", () => {
    expect(jumpBehavior(110, rendered)).toBe("smooth");
    expect(jumpBehavior(85, rendered)).toBe("smooth");
    expect(jumpBehavior(150, rendered)).toBe("smooth");
  });

  it("goes straight to a far row", () => {
    expect(jumpBehavior(10, rendered)).toBe("auto");
    expect(jumpBehavior(2900, rendered)).toBe("auto");
  });

  it("goes straight there when nothing is rendered yet", () => {
    expect(jumpBehavior(5, null)).toBe("auto");
  });
});

describe("nextPinned", () => {
  it("attaches whenever the reader is near the end", () => {
    expect(nextPinned(false, { nearBottom: true, movedUp: false })).toBe(true);
    expect(nextPinned(false, { nearBottom: true, movedUp: true })).toBe(true);
  });

  it("releases when the reader moves up away from the end", () => {
    expect(nextPinned(true, { nearBottom: false, movedUp: true })).toBe(false);
  });

  it("stays attached when content changed under the reader (no upward move)", () => {
    // History prepended: the list scrolls down by the added height while the
    // total height is still catching up, so the geometry says "not at the end".
    expect(nextPinned(true, { nearBottom: false, movedUp: false })).toBe(true);
  });

  it("stays released while the reader scrolls down but has not reached the end", () => {
    expect(nextPinned(false, { nearBottom: false, movedUp: false })).toBe(false);
  });
});

describe("nextStuck", () => {
  it("lets go on any upward move by the reader, even inside the threshold", () => {
    expect(nextStuck(true, { readerMoved: -8, nearBottom: true, atVeryEnd: false })).toBe(false);
    expect(nextStuck(true, { readerMoved: -400, nearBottom: false, atVeryEnd: false })).toBe(false);
  });

  it("stays put when the offset moved up but the list is still at its very end (content shrank, window grew)", () => {
    expect(nextStuck(true, { readerMoved: -440, nearBottom: true, atVeryEnd: true })).toBe(true);
  });

  it("takes hold at the very end", () => {
    expect(nextStuck(false, { readerMoved: 0, nearBottom: true, atVeryEnd: true })).toBe(true);
    expect(nextStuck(false, { readerMoved: 40, nearBottom: true, atVeryEnd: true })).toBe(true);
  });

  it("takes hold when the reader moves down inside the threshold", () => {
    expect(nextStuck(false, { readerMoved: 12, nearBottom: true, atVeryEnd: false })).toBe(true);
  });

  it("does not take hold while the reader is still far from the end", () => {
    expect(nextStuck(false, { readerMoved: 300, nearBottom: false, atVeryEnd: false })).toBe(false);
  });

  it("keeps its state when the reader did not move (the list moved itself, or content resized)", () => {
    expect(nextStuck(true, { readerMoved: 0, nearBottom: false, atVeryEnd: false })).toBe(true);
    expect(nextStuck(false, { readerMoved: 0, nearBottom: true, atVeryEnd: false })).toBe(false);
  });
});
