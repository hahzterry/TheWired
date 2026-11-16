import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NostrEvent } from "@/types/nostr";
import { relayManager } from "@/lib/nostr/relayManager";
import { RELAY_CANNOT_HOST_MESSAGE, createGroupConfirmed, relayServesGroup } from "../relayGroupCheck";

// An encrypted space must exist under exactly its committed id. A relay that
// refuses the id, or creates the group under one of its own, can't host one
// (docs/E2EE_SPACES.md §5.4): creation fails clearly.

const RELAY = "wss://groups.example";
const RELAY_KEY = "f".repeat(64);
const ID = "e2e1-" + "ab".repeat(16);

type Sub = { onEvent: (e: NostrEvent) => void; onEOSE: () => void };
let sub: Sub | null = null;

function metadata(over: Partial<NostrEvent> = {}): NostrEvent {
  return { id: "1".repeat(64), pubkey: RELAY_KEY, created_at: 1, kind: 39000, tags: [["d", ID]], content: "", sig: "0".repeat(128), ...over };
}

beforeEach(() => {
  sub = null;
  vi.spyOn(relayManager, "connect").mockImplementation(() => undefined as never);
  vi.spyOn(relayManager, "subscribe").mockImplementation(((opts: Sub) => {
    sub = opts;
    return "s1";
  }) as never);
  vi.spyOn(relayManager, "closeSubscription").mockImplementation(() => undefined as never);
});
afterEach(() => vi.restoreAllMocks());

describe("creating a group for an encrypted space", () => {
  it("fails when the relay refuses the create", async () => {
    vi.spyOn(relayManager, "publishWithConfirmation").mockResolvedValue([
      { relayUrl: RELAY, success: false, message: "invalid: group id" },
    ]);
    await expect(createGroupConfirmed(metadata({ kind: 9007 }), RELAY)).rejects.toThrow(RELAY_CANNOT_HOST_MESSAGE);
  });

  it("fails when the relay doesn't answer", async () => {
    vi.spyOn(relayManager, "publishWithConfirmation").mockResolvedValue([]);
    await expect(createGroupConfirmed(metadata({ kind: 9007 }), RELAY)).rejects.toThrow(RELAY_CANNOT_HOST_MESSAGE);
  });

  it("passes when the relay accepts it", async () => {
    vi.spyOn(relayManager, "publishWithConfirmation").mockResolvedValue([{ relayUrl: RELAY, success: true, message: "" }]);
    await expect(createGroupConfirmed(metadata({ kind: 9007 }), RELAY)).resolves.toBeUndefined();
  });
});

describe("does the relay serve the group under our id?", () => {
  it("yes, once its own metadata for the id arrives", async () => {
    const pending = relayServesGroup(RELAY, ID, RELAY_KEY, 1_000);
    sub!.onEOSE(); // an empty first answer is not final
    sub!.onEvent(metadata());
    expect(await pending).toBe(true);
  });

  it("no, when it doesn't within the wait (a relay that assigned its own id)", async () => {
    const pending = relayServesGroup(RELAY, ID, RELAY_KEY, 30);
    sub!.onEOSE();
    expect(await pending).toBe(false);
  });

  it("ignores metadata from anyone but the relay, or for another group", async () => {
    const pending = relayServesGroup(RELAY, ID, RELAY_KEY, 30);
    sub!.onEvent(metadata({ pubkey: "e".repeat(64) }));
    sub!.onEvent(metadata({ tags: [["d", "a-relay-chosen-id"]] }));
    expect(await pending).toBe(false);
  });
});
