import { describe, it, expect } from "vitest";
import { isNearBottom, jumpBehavior, onListChange } from "../bottomPin";

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
