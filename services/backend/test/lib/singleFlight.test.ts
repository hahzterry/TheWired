import { describe, it, expect, vi } from "vitest";
import { createSingleFlight } from "../../src/lib/singleFlight.js";

describe("createSingleFlight", () => {
  it("starts one operation for concurrent callers of the same key", async () => {
    const flights = createSingleFlight<string>();
    let settle!: (v: number) => void;
    const start = vi.fn(() => new Promise<number>((resolve) => (settle = resolve)));

    const callers = [flights.run("a", start), flights.run("a", start), flights.run("a", start)];
    expect(start).toHaveBeenCalledTimes(1);
    expect(flights.pending("a")).toBe(true);

    settle(7);
    expect(await Promise.all(callers)).toEqual([7, 7, 7]);
    expect(flights.pending("a")).toBe(false);
  });

  it("starts a new operation once the previous one settled", async () => {
    const flights = createSingleFlight<string>();
    const start = vi.fn(async () => 1);
    await flights.run("a", start);
    await flights.run("a", start);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("keeps keys apart", async () => {
    const flights = createSingleFlight<string>();
    const start = vi.fn(() => new Promise<never>(() => {}));
    void flights.run("a", start);
    void flights.run("b", start);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("clears the slot after a rejection, and hands the rejection to every waiter", async () => {
    const flights = createSingleFlight<string>();
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    const callers = [flights.run("a", failing), flights.run("a", failing)];
    for (const c of callers) await expect(c).rejects.toThrow("boom");
    expect(failing).toHaveBeenCalledTimes(1);
    expect(flights.pending("a")).toBe(false);
  });

  it("turns a synchronous throw into a rejection without leaving the slot taken", async () => {
    const flights = createSingleFlight<string>();
    await expect(
      flights.run("a", () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    expect(flights.pending("a")).toBe(false);
  });

  it("an operation that never settles is never started twice", () => {
    const flights = createSingleFlight<string>();
    const start = vi.fn(() => new Promise<never>(() => {}));
    for (let i = 0; i < 50; i++) void flights.run("a", start);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
