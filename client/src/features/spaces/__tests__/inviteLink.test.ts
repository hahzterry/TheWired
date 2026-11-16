import { describe, it, expect } from "vitest";
import {
  INVITE_MISMATCH_MESSAGE,
  INVITE_UNVERIFIABLE_MESSAGE,
  invitePath,
  parseInviteLink,
  verifyInviteSpace,
} from "../inviteLink";
import { parseContent } from "@/lib/content/parseContent";

// Invite links name the space they lead to (docs/E2EE_SPACES.md §5.4, D12):
// https://<origin>/invite/<code>/<spaceId>. The server resolves the code; the
// joining client refuses when it resolves to another space.

const ENCRYPTED = "e2e1-" + "1234abcd".repeat(4);
const PLAIN = "a1b2c3d4e5f6";

describe("invite links", () => {
  it("put the space id in the path of an encrypted space's link", () => {
    expect(invitePath("Ab3dEf9h", ENCRYPTED)).toBe(`/invite/Ab3dEf9h/${ENCRYPTED}`);
  });

  it("keep the short form for every other space, which older clients route", () => {
    expect(invitePath("Ab3dEf9h", PLAIN)).toBe("/invite/Ab3dEf9h");
    // The short form still parses to the code, and joining a plain space from
    // it is allowed.
    expect(parseInviteLink(`https://thewired.app${invitePath("Ab3dEf9h", PLAIN)}`)).toEqual({ code: "Ab3dEf9h" });
    expect(verifyInviteSpace(undefined, PLAIN)).toEqual({ ok: true });
  });

  it("parse the code and the space from a full link, a deep-link path, or a bare code", () => {
    expect(parseInviteLink(`https://thewired.app/invite/Ab3dEf9h/${ENCRYPTED}`)).toEqual({ code: "Ab3dEf9h", spaceId: ENCRYPTED });
    expect(parseInviteLink(`/invite/Ab3dEf9h/${ENCRYPTED}`)).toEqual({ code: "Ab3dEf9h", spaceId: ENCRYPTED });
    expect(parseInviteLink("https://thewired.app/invite/Ab3dEf9h")).toEqual({ code: "Ab3dEf9h" });
    expect(parseInviteLink("Ab3dEf9h")).toEqual({ code: "Ab3dEf9h" });
    expect(parseInviteLink("https://thewired.app/?invite=Ab3dEf9h")).toEqual({ code: "Ab3dEf9h" });
  });

  it("keep the space through what servers and chat clients do to a link", () => {
    const link = `https://thewired.app/invite/Ab3dEf9h/${ENCRYPTED}`;
    // A query or fragment added on the way, and a trailing slash.
    expect(parseInviteLink(`${link}?utm_source=x#top`)).toEqual({ code: "Ab3dEf9h", spaceId: ENCRYPTED });
    expect(parseInviteLink(`${link}/`)).toEqual({ code: "Ab3dEf9h", spaceId: ENCRYPTED });
    // The public invite page keeps the request path and drops only the query
    // (its canonical URL is origin + path), so the id survives it.
    const serverCanonical = new URL(`${link}?ref=share`).pathname;
    expect(parseInviteLink(`https://thewired.app${serverCanonical}`)).toEqual({ code: "Ab3dEf9h", spaceId: ENCRYPTED });
  });

  it("are found in chat text with their space", () => {
    const segs = parseContent(`join us: https://thewired.app/invite/Ab3dEf9h/${ENCRYPTED} see you`);
    expect(segs.find((s) => s.type === "invite")).toEqual({ type: "invite", code: "Ab3dEf9h", spaceId: ENCRYPTED });
    const old = parseContent("old link https://thewired.app/invite/Ab3dEf9h");
    expect(old.find((s) => s.type === "invite")).toEqual({ type: "invite", code: "Ab3dEf9h" });
  });
});

describe("checking the space the server resolved an invite to", () => {
  it("accepts the space the link names", () => {
    expect(verifyInviteSpace(ENCRYPTED, ENCRYPTED)).toEqual({ ok: true });
    expect(verifyInviteSpace(PLAIN, PLAIN)).toEqual({ ok: true });
  });

  it("refuses a server that resolves the code to a different space", () => {
    expect(verifyInviteSpace(ENCRYPTED, "e2e1-" + "9".repeat(32))).toEqual({
      ok: false,
      reason: "mismatch",
      message: INVITE_MISMATCH_MESSAGE,
    });
    expect(verifyInviteSpace(PLAIN, ENCRYPTED)).toMatchObject({ ok: false, reason: "mismatch" });
  });

  it("keeps old links working for plain spaces, and refuses them for encrypted ones", () => {
    expect(verifyInviteSpace(undefined, PLAIN)).toEqual({ ok: true });
    expect(verifyInviteSpace(undefined, ENCRYPTED)).toEqual({
      ok: false,
      reason: "unverifiable",
      message: INVITE_UNVERIFIABLE_MESSAGE,
    });
  });
});
