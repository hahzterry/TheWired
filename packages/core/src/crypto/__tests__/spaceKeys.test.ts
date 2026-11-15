import { describe, it, expect } from "vitest";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { getConversationKey, decrypt as nip44Decrypt } from "nostr-tools/nip44";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  SPACE_E2EE_KINDS,
  SPACE_KEY_GRANT_MAX_RECIPIENTS,
  SPACE_SEALED_MAX_PLAINTEXT_BYTES,
  type NostrEvent,
} from "@ishtarservices/shared-types";
import {
  SpaceE2eeError,
  buildSpaceKeyGrants,
  buildSpaceRumor,
  epochIdOf,
  generateEpochKey,
  judgeEpochGrant,
  openSealedSpaceEvent,
  openSpaceKeyGrant,
  openSpaceKeyGrantWithKey,
  pickSendEpoch,
  readGrantHeader,
  readSealedHeader,
  sealSpaceEvent,
  sealedAsEvent,
  spaceContentKey,
  spaceGrantKey,
} from "../spaceKeys";
import { makeTestIdentity, type TestIdentity } from "./testSigner";
import fixtures from "../../../../shared-types/fixtures/space-e2ee-v1.json";

/** Flip one character in the middle of a base64 payload. */
function tamper(payload: string): string {
  const i = Math.floor(payload.length / 2);
  return payload.slice(0, i) + (payload[i] === "A" ? "B" : "A") + payload.slice(i + 1);
}

const SPACE = "space-under-test";

function sign(unsigned: unknown, who: TestIdentity): NostrEvent {
  return finalizeEvent(unsigned as Parameters<typeof finalizeEvent>[0], who.sk) as unknown as NostrEvent;
}

function seal(who: TestIdentity, key: Uint8Array, content: string, space = SPACE): NostrEvent {
  const rumor = buildSpaceRumor(who.pubkey, space, 9, [["channel", "general"]], content);
  return sign(sealSpaceEvent(rumor, space, key), who);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SpaceE2eeError);
    return (err as SpaceE2eeError).code;
  }
  throw new Error("expected a SpaceE2eeError");
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SpaceE2eeError);
    return (err as SpaceE2eeError).code;
  }
  throw new Error("expected a SpaceE2eeError");
}

function grantFor(
  granter: TestIdentity,
  key: Uint8Array,
  recipients: string[],
  over: Partial<Parameters<typeof buildSpaceKeyGrants>[0]> = {},
): NostrEvent[] {
  return buildSpaceKeyGrants({
    granter: granter.pubkey,
    spaceId: SPACE,
    epochKey: key,
    seq: 0,
    prev: null,
    root: granter.pubkey,
    managers: [granter.pubkey],
    history: "epoch",
    at: 1_763_000_000,
    recipients,
    ...over,
  }).map((u) => sign(u, granter));
}

describe("key derivation", () => {
  it("names an epoch by a 16-hex id that differs per key", () => {
    const a = generateEpochKey();
    const b = generateEpochKey();
    expect(a).toHaveLength(32);
    expect(epochIdOf(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(epochIdOf(a)).toBe(epochIdOf(a));
    expect(epochIdOf(a)).not.toBe(epochIdOf(b));
  });

  it("separates the content key from the grant key and binds both to the space", () => {
    const key = generateEpochKey();
    const content = bytesToHex(spaceContentKey(key, SPACE));
    expect(content).not.toBe(bytesToHex(spaceGrantKey(key, SPACE)));
    expect(content).not.toBe(bytesToHex(spaceContentKey(key, "another-space")));
    expect(content).not.toBe(bytesToHex(key));
  });

  it("refuses a key of the wrong length", () => {
    expect(codeOf(() => epochIdOf(new Uint8Array(16)))).toBe("malformed");
  });
});

describe("sealed space events", () => {
  const alice = makeTestIdentity();
  const bob = makeTestIdentity();
  const key = generateEpochKey();

  it("round-trips a chat message and exposes only h and epoch", () => {
    const event = seal(alice, key, "hello, space");
    expect(event.kind).toBe(SPACE_E2EE_KINDS.SEALED_EVENT);
    expect(event.tags).toEqual([
      ["h", SPACE],
      ["epoch", epochIdOf(key)],
    ]);
    expect(event.content).not.toContain("hello");
    expect(JSON.stringify(event)).not.toContain("general");
    expect(readSealedHeader(event)).toEqual({ spaceId: SPACE, epochId: epochIdOf(key) });

    const rumor = openSealedSpaceEvent(event, key);
    expect(rumor.content).toBe("hello, space");
    expect(rumor.kind).toBe(9);
    expect(rumor.pubkey).toBe(alice.pubkey);
    expect(rumor.tags).toEqual([
      ["h", SPACE],
      ["channel", "general"],
    ]);
  });

  it("encrypts the same message to different ciphertext each time", () => {
    const rumor = buildSpaceRumor(alice.pubkey, SPACE, 9, [], "same words");
    const a = sealSpaceEvent(rumor, SPACE, key);
    const b = sealSpaceEvent(rumor, SPACE, key);
    expect(a.content).not.toBe(b.content);
  });

  it("rejects a tampered ciphertext", () => {
    const event = seal(alice, key, "untouched");
    const tampered = { ...event, content: tamper(event.content) };
    expect(codeOf(() => openSealedSpaceEvent(tampered, key))).toBe("decrypt");
  });

  it("rejects a truncated ciphertext and non-base64 content", () => {
    const event = seal(alice, key, "untouched");
    expect(codeOf(() => openSealedSpaceEvent({ ...event, content: event.content.slice(0, 60) }, key))).toBe("decrypt");
    expect(codeOf(() => openSealedSpaceEvent({ ...event, content: "not a payload" }, key))).toBe("decrypt");
  });

  it("rejects the wrong key: another epoch's key is refused before decrypting", () => {
    const event = seal(alice, key, "for holders of this epoch");
    expect(codeOf(() => openSealedSpaceEvent(event, generateEpochKey()))).toBe("epoch");
  });

  it("rejects a key whose epoch tag was rewritten to match", () => {
    const other = generateEpochKey();
    const event = seal(alice, key, "for holders of this epoch");
    const relabeled = { ...event, tags: [["h", SPACE], ["epoch", epochIdOf(other)]] };
    expect(codeOf(() => openSealedSpaceEvent(relabeled, other))).toBe("decrypt");
  });

  it("rejects a ciphertext moved to another space, even under the same epoch key", () => {
    const event = seal(alice, key, "stays here");
    const moved = { ...event, tags: [["h", "another-space"], ["epoch", epochIdOf(key)]] };
    expect(codeOf(() => openSealedSpaceEvent(moved, key))).toBe("decrypt");
  });

  it("rejects one member re-posting another member's ciphertext as their own", () => {
    const fromAlice = seal(alice, key, "alice said this");
    const stolen = sign(
      { kind: fromAlice.kind, created_at: fromAlice.created_at, tags: fromAlice.tags, content: fromAlice.content },
      bob,
    );
    expect(codeOf(() => openSealedSpaceEvent(stolen, key))).toBe("sender");
  });

  it("rejects a rumor whose own h tag names another space", () => {
    const rumor = buildSpaceRumor(alice.pubkey, "another-space", 9, [], "smuggled");
    expect(codeOf(() => sealSpaceEvent(rumor, SPACE, key))).toBe("space");
  });

  it("rejects a rumor whose id does not match its content", () => {
    const rumor = buildSpaceRumor(alice.pubkey, SPACE, 9, [], "original");
    const forged = sealSpaceEvent({ ...rumor, content: "swapped" }, SPACE, key);
    expect(codeOf(() => openSealedSpaceEvent(sign(forged, alice), key))).toBe("id");
  });

  it("drops rumor kinds this version does not accept, unless the caller widens the set", () => {
    const rumor = buildSpaceRumor(alice.pubkey, SPACE, 7, [["e", "f".repeat(64)]], "+");
    const event = sign(sealSpaceEvent(rumor, SPACE, key), alice);
    expect(codeOf(() => openSealedSpaceEvent(event, key))).toBe("kind");
    expect(openSealedSpaceEvent(event, key, { acceptKinds: [7, 9] }).content).toBe("+");
  });

  it("rejects malformed outer events", () => {
    const event = seal(alice, key, "x");
    expect(readSealedHeader({ ...event, kind: 9 })).toBeNull();
    expect(readSealedHeader({ ...event, tags: [["h", SPACE]] })).toBeNull();
    expect(readSealedHeader({ ...event, tags: [["h", SPACE], ["h", "b"], ["epoch", epochIdOf(key)]] })).toBeNull();
    expect(readSealedHeader({ ...event, tags: [["h", SPACE], ["epoch", "nothex"]] })).toBeNull();
    expect(codeOf(() => openSealedSpaceEvent({ ...event, tags: [["h", SPACE]] }, key))).toBe("malformed");
  });

  it("refuses to seal a rumor over the size bound", () => {
    const rumor = buildSpaceRumor(alice.pubkey, SPACE, 9, [], "x".repeat(SPACE_SEALED_MAX_PLAINTEXT_BYTES));
    expect(codeOf(() => sealSpaceEvent(rumor, SPACE, key))).toBe("size");
  });

  it("renders under the outer id, time and signature", () => {
    const event = seal(alice, key, "identity");
    const rendered = sealedAsEvent(event, openSealedSpaceEvent(event, key));
    expect(rendered.id).toBe(event.id);
    expect(rendered.sig).toBe(event.sig);
    expect(rendered.created_at).toBe(event.created_at);
    expect(rendered.kind).toBe(9);
    expect(rendered.content).toBe("identity");
    // A replayed rumor keeps its rumor id while the outer id changes, which is
    // what lets a receiver drop the second copy.
    const again = sign(sealSpaceEvent(openSealedSpaceEvent(event, key), SPACE, key), alice);
    expect(openSealedSpaceEvent(again, key).id).toBe(openSealedSpaceEvent(event, key).id);
  });
});

describe("key grants", () => {
  const alice = makeTestIdentity();
  const bob = makeTestIdentity();
  const carol = makeTestIdentity();
  const key = generateEpochKey();

  it("hands the key to every recipient with one signed event", async () => {
    const [grant, ...rest] = grantFor(alice, key, [alice.pubkey, bob.pubkey]);
    expect(rest).toHaveLength(0);
    expect(grant.kind).toBe(SPACE_E2EE_KINDS.KEY_GRANT);
    expect(JSON.stringify(grant)).not.toContain(bytesToHex(key));
    expect(readGrantHeader(grant)).toMatchObject({
      spaceId: SPACE,
      epochId: epochIdOf(key),
      recipients: [alice.pubkey, bob.pubkey],
    });

    for (const who of [alice, bob]) {
      const opened = await openSpaceKeyGrant(grant, who.pubkey, who.signer.nip44Decrypt);
      expect(bytesToHex(opened.key)).toBe(bytesToHex(key));
      expect(opened.payload).toEqual({
        v: 1,
        space: SPACE,
        epoch: epochIdOf(key),
        seq: 0,
        prev: null,
        root: alice.pubkey,
        managers: [alice.pubkey],
        history: "epoch",
        at: 1_763_000_000,
      });
    }
  });

  it("gives a non-recipient nothing", async () => {
    const [grant] = grantFor(alice, key, [alice.pubkey, bob.pubkey]);
    expect(await codeOfAsync(() => openSpaceKeyGrant(grant, carol.pubkey, carol.signer.nip44Decrypt))).toBe(
      "not-recipient",
    );
    // Carol trying Bob's entry with her own key gets no key either.
    const bobEntry = grant.tags.find((t) => t[0] === "p" && t[1] === bob.pubkey)![2];
    const eph = grant.tags.find((t) => t[0] === "eph")![1];
    await expect(carol.signer.nip44Decrypt(eph, bobEntry)).rejects.toThrow();
  });

  it("splits more than the per-event limit across grants with distinct throwaway keys", async () => {
    const members = Array.from({ length: SPACE_KEY_GRANT_MAX_RECIPIENTS + 1 }, () => makeTestIdentity());
    const grants = grantFor(alice, key, members.map((m) => m.pubkey));
    expect(grants).toHaveLength(2);
    expect(readGrantHeader(grants[0])!.recipients).toHaveLength(SPACE_KEY_GRANT_MAX_RECIPIENTS);
    expect(readGrantHeader(grants[1])!.recipients).toEqual([members[SPACE_KEY_GRANT_MAX_RECIPIENTS].pubkey]);
    expect(readGrantHeader(grants[0])!.ephemeralPubkey).not.toBe(readGrantHeader(grants[1])!.ephemeralPubkey);
    expect(JSON.stringify(grants[0]).length).toBeLessThan(100_000);

    const last = members[SPACE_KEY_GRANT_MAX_RECIPIENTS];
    const opened = await openSpaceKeyGrant(grants[1], last.pubkey, last.signer.nip44Decrypt);
    expect(bytesToHex(opened.key)).toBe(bytesToHex(key));
  });

  it("de-duplicates recipients and builds nothing for an empty list", () => {
    expect(grantFor(alice, key, [])).toHaveLength(0);
    const [grant] = grantFor(alice, key, [bob.pubkey, bob.pubkey]);
    expect(grant.tags.filter((t) => t[0] === "p")).toHaveLength(1);
  });

  it("rejects an entry that carries a key for another epoch", async () => {
    const other = generateEpochKey();
    const [real] = grantFor(alice, key, [bob.pubkey]);
    const [decoy] = grantFor(alice, other, [bob.pubkey]);
    // The real grant's header and payload, with the decoy's wrapped key.
    const spliced = {
      ...real,
      tags: real.tags.map((t) => (t[0] === "p" || t[0] === "eph" ? decoy.tags.find((d) => d[0] === t[0])! : t)),
    };
    expect(await codeOfAsync(() => openSpaceKeyGrant(spliced, bob.pubkey, bob.signer.nip44Decrypt))).toBe("epoch");
  });

  it("rejects a grant replayed into another space", async () => {
    const [grant] = grantFor(alice, key, [bob.pubkey]);
    const moved = { ...grant, tags: grant.tags.map((t) => (t[0] === "h" ? ["h", "another-space"] : t)) };
    expect(await codeOfAsync(() => openSpaceKeyGrant(moved, bob.pubkey, bob.signer.nip44Decrypt))).toBe("decrypt");
  });

  it("rejects a tampered payload", async () => {
    const [grant] = grantFor(alice, key, [bob.pubkey]);
    const tampered = { ...grant, content: tamper(grant.content) };
    expect(await codeOfAsync(() => openSpaceKeyGrant(tampered, bob.pubkey, bob.signer.nip44Decrypt))).toBe("decrypt");
  });

  it("treats a signer that returns garbage as a failed decrypt, and rethrows a signer error", async () => {
    const [grant] = grantFor(alice, key, [bob.pubkey]);
    expect(await codeOfAsync(() => openSpaceKeyGrant(grant, bob.pubkey, async () => "garbage"))).toBe("decrypt");
    const away = new Error("signer timed out");
    await expect(
      openSpaceKeyGrant(grant, bob.pubkey, async () => {
        throw away;
      }),
    ).rejects.toBe(away);
  });

  it("rejects malformed grants", () => {
    const [grant] = grantFor(alice, key, [bob.pubkey]);
    expect(readGrantHeader({ ...grant, kind: 4290 })).toBeNull();
    expect(readGrantHeader({ ...grant, tags: grant.tags.filter((t) => t[0] !== "eph") })).toBeNull();
    expect(readGrantHeader({ ...grant, tags: grant.tags.filter((t) => t[0] !== "p") })).toBeNull();
    expect(readGrantHeader({ ...grant, tags: [...grant.tags, ["p", "nothex", "x"]] })).toBeNull();
    expect(readGrantHeader({ ...grant, tags: [...grant.tags, ["p", bob.pubkey]] })).toBeNull();
  });

  it("always lists the root among the managers", async () => {
    const [grant] = grantFor(alice, key, [bob.pubkey], { root: alice.pubkey, managers: [carol.pubkey] });
    const opened = await openSpaceKeyGrant(grant, bob.pubkey, bob.signer.nip44Decrypt);
    expect(opened.payload.root).toBe(alice.pubkey);
    expect(opened.payload.managers).toEqual([alice.pubkey, carol.pubkey]);
  });

  it("refuses to build an epoch whose seq and prev disagree", () => {
    expect(codeOf(() => grantFor(alice, key, [bob.pubkey], { seq: 1, prev: null }))).toBe("malformed");
    expect(codeOf(() => grantFor(alice, key, [bob.pubkey], { seq: 0, prev: "ab".repeat(8) }))).toBe("malformed");
    expect(codeOf(() => grantFor(alice, key, [bob.pubkey], { root: "nothex" }))).toBe("malformed");
  });

  it("lets a key holder read another grant for the same epoch", () => {
    const [grant] = grantFor(alice, key, [carol.pubkey], { seq: 4, prev: "ab".repeat(8), history: "full" });
    expect(openSpaceKeyGrantWithKey(grant, key)).toMatchObject({ seq: 4, prev: "ab".repeat(8), history: "full" });
    expect(codeOf(() => openSpaceKeyGrantWithKey(grant, generateEpochKey()))).toBe("epoch");
  });
});

describe("who may issue an epoch", () => {
  const ROOT = "a".repeat(64);
  const MGR = "b".repeat(64);
  const EX = "c".repeat(64);
  const e = (id: string, seq: number, prev: string | null, managers: string[]) => ({ id, seq, prev, managers });
  const p = (epoch: string, seq: number, prev: string | null, root = ROOT) => ({ epoch, seq, prev, root });
  const chain = [e("e0", 0, null, [ROOT, MGR, EX]), e("e1", 1, "e0", [ROOT, MGR])];

  it("rejects a payload naming another root", () => {
    expect(judgeEpochGrant(p("e2", 2, "e1", EX), ROOT, ROOT, chain)).toBe("reject");
    expect(judgeEpochGrant(p("e2", 2, "e1", EX), EX, ROOT, chain)).toBe("reject");
  });

  it("accepts anything from the root", () => {
    expect(judgeEpochGrant(p("e2", 2, "e1"), ROOT, ROOT, chain)).toBe("accept");
    expect(judgeEpochGrant(p("zz", 9, "unknown"), ROOT, ROOT, chain)).toBe("accept");
  });

  it("accepts a manager of the predecessor extending the chain by exactly one", () => {
    expect(judgeEpochGrant(p("e2", 2, "e1"), MGR, ROOT, chain)).toBe("accept");
  });

  it("rejects a manager dropped at the last rotation", () => {
    // EX managed e0 but not e1: nothing EX issues after e1 is acceptable.
    expect(judgeEpochGrant(p("e2", 2, "e1"), EX, ROOT, chain)).toBe("reject");
  });

  it("rejects a jump ahead of the chain", () => {
    expect(judgeEpochGrant(p("far", 1_000_000_000, "e1"), MGR, ROOT, chain)).toBe("reject");
    expect(judgeEpochGrant(p("fork", 5, "e0"), MGR, ROOT, chain)).toBe("reject");
  });

  it("lets a dropped manager fork only from an epoch they managed, one step", () => {
    // A sibling of e1. Every member holds both; the root's next rotation
    // (seq 2 on e1) outranks it and EX cannot follow.
    expect(judgeEpochGrant(p("e1x", 1, "e0"), EX, ROOT, chain)).toBe("accept");
    const withFork = [...chain, e("e1x", 1, "e0", [ROOT, EX]), e("e2", 2, "e1", [ROOT, MGR])];
    expect(judgeEpochGrant(p("e3", 3, "e2"), EX, ROOT, withFork)).toBe("reject");
  });

  it("defers an epoch whose predecessor has not arrived yet", () => {
    expect(judgeEpochGrant(p("e3", 3, "e2"), MGR, ROOT, chain)).toBe("defer");
  });

  it("fills in history that an accepted epoch points back to", () => {
    const tail = [e("e1", 1, "e0", [ROOT, MGR])];
    expect(judgeEpochGrant(p("e0", 0, null), MGR, ROOT, tail)).toBe("accept");
    expect(judgeEpochGrant(p("e0", 0, null), EX, ROOT, tail)).toBe("reject");
    expect(judgeEpochGrant(p("e0", 7, null), MGR, ROOT, tail)).toBe("reject");
  });

  it("rejects a first epoch from anyone but the root", () => {
    expect(judgeEpochGrant(p("other", 0, null), MGR, ROOT, chain)).toBe("reject");
  });
});

describe("rotation", () => {
  const alice = makeTestIdentity();
  const bob = makeTestIdentity();
  const carol = makeTestIdentity();

  it("a removed member's key fails on messages sealed after the rotation", async () => {
    const epoch0 = generateEpochKey();
    const [g0] = grantFor(alice, epoch0, [alice.pubkey, bob.pubkey, carol.pubkey]);
    const carolsKey = (await openSpaceKeyGrant(g0, carol.pubkey, carol.signer.nip44Decrypt)).key;
    const before = seal(bob, epoch0, "carol can read this");
    expect(openSealedSpaceEvent(before, carolsKey).content).toBe("carol can read this");

    // Carol is removed: a new epoch goes to Alice and Bob only.
    const epoch1 = generateEpochKey();
    const [g1] = grantFor(alice, epoch1, [alice.pubkey, bob.pubkey], { seq: 1, prev: epochIdOf(epoch0) });
    expect(readGrantHeader(g1)!.recipients).not.toContain(carol.pubkey);
    expect(await codeOfAsync(() => openSpaceKeyGrant(g1, carol.pubkey, carol.signer.nip44Decrypt))).toBe(
      "not-recipient",
    );

    const after = seal(bob, epoch1, "carol cannot read this");
    expect(codeOf(() => openSealedSpaceEvent(after, carolsKey))).toBe("epoch");
    // Even ignoring the epoch tag, her key does not decrypt it.
    expect(() => nip44Decrypt(after.content, spaceContentKey(carolsKey, SPACE))).toThrow();

    const bobsKey = (await openSpaceKeyGrant(g1, bob.pubkey, bob.signer.nip44Decrypt)).key;
    expect(openSealedSpaceEvent(after, bobsKey).content).toBe("carol cannot read this");
    // Members who were there keep reading the old epoch.
    expect(openSealedSpaceEvent(before, epoch0).content).toBe("carol can read this");
  });

  it("a member who joins after a rotation reads the new epoch and not the old one", async () => {
    const dave = makeTestIdentity();
    const epoch0 = generateEpochKey();
    const epoch1 = generateEpochKey();
    const old = seal(alice, epoch0, "before dave");
    const current = seal(alice, epoch1, "dave can read this");

    const [late] = grantFor(alice, epoch1, [dave.pubkey], { seq: 1, prev: epochIdOf(epoch0) });
    const davesKey = (await openSpaceKeyGrant(late, dave.pubkey, dave.signer.nip44Decrypt)).key;
    expect(openSealedSpaceEvent(current, davesKey).content).toBe("dave can read this");
    expect(codeOf(() => openSealedSpaceEvent(old, davesKey))).toBe("epoch");
  });

  it("sends with the highest seq and breaks ties by the smaller epoch id", () => {
    expect(pickSendEpoch([])).toBeNull();
    expect(pickSendEpoch([{ id: "bb", seq: 0 }, { id: "aa", seq: 2 }, { id: "cc", seq: 1 }])!.id).toBe("aa");
    expect(pickSendEpoch([{ id: "bb", seq: 3 }, { id: "aa", seq: 3 }])!.id).toBe("aa");
  });
});

// The contract fixtures other implementations check themselves against.
describe("contract fixtures (packages/shared-types/fixtures/space-e2ee-v1.json)", () => {
  const fx = fixtures;
  const who = (name: "alice" | "bob" | "carol") => {
    const sk = hexToBytes(fx.identities[name].secretKey);
    return {
      pubkey: fx.identities[name].pubkey as string,
      decrypt: async (peer: string, ct: string) => nip44Decrypt(ct, getConversationKey(sk, peer)),
    };
  };

  it("pins the derivations", () => {
    expect(fx.version).toBe(1);
    for (const name of ["alice", "bob", "carol"] as const) {
      expect(getPublicKey(hexToBytes(fx.identities[name].secretKey))).toBe(fx.identities[name].pubkey);
    }
    for (const epoch of [fx.epoch0, fx.epoch1]) {
      const key = hexToBytes(epoch.key);
      expect(epochIdOf(key)).toBe(epoch.epochId);
      expect(bytesToHex(spaceContentKey(key, fx.space))).toBe(epoch.contentKey);
      expect(bytesToHex(spaceGrantKey(key, fx.space))).toBe(epoch.grantKey);
    }
    // Hard-coded so a change to the salt or the info strings fails here.
    expect(fx.epoch0.epochId).toBe("200013a76bca3727");
    expect(fx.epoch1.epochId).toBe("6d3b6765bc8dbceb");
  });

  it("opens the sealed events to their rumors", () => {
    for (const epoch of [fx.epoch0, fx.epoch1]) {
      expect(verifyEvent(epoch.sealed)).toBe(true);
      expect(openSealedSpaceEvent(epoch.sealed, hexToBytes(epoch.key))).toEqual(epoch.rumor);
    }
  });

  it("unwraps each grant for its recipients and nobody else", async () => {
    expect(verifyEvent(fx.epoch0.grant)).toBe(true);
    expect(verifyEvent(fx.epoch1.grant)).toBe(true);
    for (const name of ["alice", "bob", "carol"] as const) {
      const me = who(name);
      const opened = await openSpaceKeyGrant(fx.epoch0.grant, me.pubkey, me.decrypt);
      expect(bytesToHex(opened.key)).toBe(fx.epoch0.key);
      expect(opened.payload).toEqual(fx.epoch0.payload);
    }
    const bob = who("bob");
    const opened = await openSpaceKeyGrant(fx.epoch1.grant, bob.pubkey, bob.decrypt);
    expect(bytesToHex(opened.key)).toBe(fx.epoch1.key);
    expect(opened.payload).toEqual(fx.epoch1.payload);

    const carol = who("carol");
    expect(await codeOfAsync(() => openSpaceKeyGrant(fx.epoch1.grant, carol.pubkey, carol.decrypt))).toBe(
      "not-recipient",
    );
    expect(codeOf(() => openSealedSpaceEvent(fx.epoch1.sealed, hexToBytes(fx.epoch0.key)))).toBe("epoch");
  });
});
