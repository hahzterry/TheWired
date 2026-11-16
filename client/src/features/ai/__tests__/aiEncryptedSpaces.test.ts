import { describe, it, expect, beforeEach } from "vitest";
import { store, resetAll } from "@/store";
import { login } from "@/store/slices/identitySlice";
import { addSpace, setChannels } from "@/store/slices/spacesSlice";
import { addEvent, indexChatMessage } from "@/store/slices/eventsSlice";
import { hydrateSpaceE2ee } from "@/store/slices/spaceE2eeSlice";
import type { NostrEvent } from "@/types/nostr";
import type { Space } from "@/types/space";
import { buildChannelContext, buildNoteContext, buildSpaceContext, buildThreadContext } from "../context/aiContext";
import { getActiveTools, runTool } from "../tools/registry";

// Messages of an end-to-end encrypted space are decrypted on this device for
// its user only. None of them may reach a model (docs/E2EE_SPACES.md §8):
// not through the auto-run read tools, not through "Ask AI" context.

const ME = "a".repeat(64);
const SEALED = "sealedspace";
const PLAIN = "plainspace";
const CTX = { conversationId: "c1", messageId: "m1", toolCallId: "t1" };

function space(id: string): Space {
  return {
    id,
    hostRelay: "wss://r",
    name: id,
    isPrivate: false,
    adminPubkeys: [ME],
    memberPubkeys: [ME],
    feedPubkeys: [],
    mode: "read-write",
    creatorPubkey: ME,
    createdAt: 1,
  };
}

function chat(n: number, spaceId: string, content: string): NostrEvent {
  return {
    id: n.toString(16).padStart(64, "0"),
    pubkey: "b".repeat(64),
    created_at: 1_700_000_000 + n,
    kind: 9,
    tags: [["h", spaceId], ["channel", "chat"]],
    content,
    sig: "0".repeat(128),
  };
}

beforeEach(() => {
  store.dispatch(resetAll());
  store.dispatch(login({ pubkey: ME, signerType: "nip07" }));
  for (const id of [SEALED, PLAIN]) {
    store.dispatch(addSpace(space(id)));
    store.dispatch(setChannels({ spaceId: id, channels: [{ id: "chat", spaceId: id, type: "chat", label: "chat" }] } as never));
  }
  store.dispatch(hydrateSpaceE2ee({ account: ME, spaces: { [SEALED]: { root: ME, epochs: [], holders: {} } } }));
  const secret = chat(1, SEALED, "the secret plan");
  const open = chat(2, PLAIN, "the public plan");
  for (const e of [secret, open]) {
    store.dispatch(addEvent(e));
    store.dispatch(indexChatMessage({ groupId: e.tags[0][1], eventId: e.id }));
  }
});

describe("AI context of an encrypted space", () => {
  it("builds no space, channel, note or thread context from it", () => {
    expect(buildSpaceContext(SEALED)).toBeNull();
    expect(buildChannelContext(SEALED, "chat")).toBeNull();
    expect(buildNoteContext(chat(1, SEALED, "").id)).toBeNull();
    expect(buildThreadContext(chat(1, SEALED, "").id)).toBeNull();
    // An ordinary space is unchanged.
    expect(JSON.stringify(buildSpaceContext(PLAIN))).toContain("the public plan");
    expect(buildNoteContext(chat(2, PLAIN, "").id)).not.toBeNull();
  });

  it("keeps it out of the auto-run read tools", async () => {
    const tools = getActiveTools().map((t) => t.name);
    expect(tools).toContain("read_space_feed");
    const feed = await runTool("read_space_feed", JSON.stringify({ spaceId: SEALED }), CTX);
    expect(JSON.stringify(feed)).not.toContain("the secret plan");
    expect(JSON.stringify(feed)).toMatch(/end-to-end encrypted/);

    const search = await runTool("search_notes", JSON.stringify({ query: "plan" }), CTX);
    expect(JSON.stringify(search)).not.toContain("the secret plan");
    expect(JSON.stringify(search)).toContain("the public plan");
  });
});
