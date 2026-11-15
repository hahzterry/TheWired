import { describe, it, expect, beforeEach, vi } from "vitest";

const keychain = new Map<string, string>();
vi.mock("@/lib/nostr/secretStore", () => ({
  getSecret: async (k: string) => keychain.get(k) ?? null,
  setSecret: async (k: string, v: string) => void keychain.set(k, v),
  deleteSecret: async (k: string) => void keychain.delete(k),
}));

import {
  MAX_STORED_EPOCHS,
  forgetSpaceKeys,
  listSpacesWithKeys,
  loadSpaceKeys,
  saveSpaceKey,
  spaceKeyIndexSlot,
  spaceKeySlot,
} from "../spaceKeyStore";

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);
const epochId = (n: number) => n.toString(16).padStart(16, "0");
const keyHex = (n: number) => n.toString(16).padStart(64, "0");

beforeEach(() => keychain.clear());

describe("spaceKeyStore", () => {
  it("stores keys per account and per space, and lists the spaces", async () => {
    await saveSpaceKey(ME, "s1", epochId(1), keyHex(1));
    await saveSpaceKey(ME, "s1", epochId(2), keyHex(2));
    await saveSpaceKey(ME, "s2", epochId(3), keyHex(3));
    await saveSpaceKey(OTHER, "s1", epochId(9), keyHex(9));

    expect(await loadSpaceKeys(ME, "s1")).toEqual({ [epochId(1)]: keyHex(1), [epochId(2)]: keyHex(2) });
    expect(await loadSpaceKeys(OTHER, "s1")).toEqual({ [epochId(9)]: keyHex(9) });
    expect(await listSpacesWithKeys(ME)).toEqual(["s1", "s2"]);
    expect([...keychain.keys()].sort()).toEqual(
      [spaceKeySlot(ME, "s1"), spaceKeySlot(ME, "s2"), spaceKeyIndexSlot(ME), spaceKeySlot(OTHER, "s1"), spaceKeyIndexSlot(OTHER)].sort(),
    );
  });

  it("does not lose keys when grants land at the same time", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => saveSpaceKey(ME, "s1", epochId(i), keyHex(i))));
    expect(Object.keys(await loadSpaceKeys(ME, "s1"))).toHaveLength(12);
  });

  it("rejects malformed ids and keys, and ignores malformed stored entries", async () => {
    await expect(saveSpaceKey(ME, "s1", "nothex", keyHex(1))).rejects.toThrow();
    await expect(saveSpaceKey(ME, "s1", epochId(1), "short")).rejects.toThrow();
    keychain.set(spaceKeySlot(ME, "s1"), JSON.stringify({ v: 1, keys: { [epochId(1)]: keyHex(1), bad: "x", [epochId(2)]: 5 } }));
    expect(await loadSpaceKeys(ME, "s1")).toEqual({ [epochId(1)]: keyHex(1) });
    keychain.set(spaceKeySlot(ME, "s1"), "not json");
    expect(await loadSpaceKeys(ME, "s1")).toEqual({});
    keychain.set(spaceKeySlot(ME, "s1"), JSON.stringify({ v: 2, keys: { [epochId(1)]: keyHex(1) } }));
    expect(await loadSpaceKeys(ME, "s1")).toEqual({});
  });

  it("bounds the epochs kept per space, dropping the oldest", async () => {
    for (let i = 0; i < MAX_STORED_EPOCHS + 3; i++) await saveSpaceKey(ME, "s1", epochId(i), keyHex(i));
    const keys = await loadSpaceKeys(ME, "s1");
    expect(Object.keys(keys)).toHaveLength(MAX_STORED_EPOCHS);
    expect(keys[epochId(0)]).toBeUndefined();
    expect(keys[epochId(MAX_STORED_EPOCHS + 2)]).toBe(keyHex(MAX_STORED_EPOCHS + 2));
  });

  it("forgets a space's keys and drops it from the index", async () => {
    await saveSpaceKey(ME, "s1", epochId(1), keyHex(1));
    await saveSpaceKey(ME, "s2", epochId(2), keyHex(2));
    await forgetSpaceKeys(ME, "s1");
    expect(await loadSpaceKeys(ME, "s1")).toEqual({});
    expect(await listSpacesWithKeys(ME)).toEqual(["s2"]);
  });
});
