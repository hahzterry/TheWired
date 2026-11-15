import { describe, it, expect } from "vitest";
import {
  redactComponentStack,
  redactMessage,
  redactStack,
  redactTokens,
  sanitizeName,
  sanitizeRoute,
} from "../redact";

const HEX64 = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
const NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
const NPUB = "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6";

describe("redactTokens", () => {
  it("removes secret keys in every encoding", () => {
    const out = redactTokens(`key ${NSEC} and ${HEX64} and ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kgh`);
    expect(out).not.toContain(NSEC);
    expect(out).not.toContain(HEX64);
    expect(out).not.toMatch(/ncryptsec1q/);
    expect(out).toContain("[redacted-nsec]");
    expect(out).toContain("[redacted-hex]");
  });

  it("removes public identifiers too, since a 64-hex secret key looks the same", () => {
    const out = redactTokens(`profile ${NPUB} note1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sx0f7dc`);
    expect(out).not.toContain(NPUB);
    expect(out).not.toMatch(/note1qqq/);
  });

  it("removes bunker, nostrconnect and wallet-connect URIs whole", () => {
    const out = redactTokens(
      `bunker://${HEX64}?relay=wss://r.example&secret=abc nostr+walletconnect://${HEX64}?relay=wss://r&secret=${HEX64}`,
    );
    expect(out).toBe("[redacted-uri] [redacted-uri]");
  });

  it("removes API keys and authorization values", () => {
    const out = redactTokens(
      "sk-ant-api03-abcdefghijklmnopqrstuvwx Authorization: Nostr eyJraW5kIjoyNzIzNSwiY29udGVudCI6IiJ9 Bearer abcdefghijklmnop1234",
    );
    expect(out).not.toContain("sk-ant-api03");
    expect(out).not.toContain("eyJraW5k");
    expect(out).not.toContain("abcdefghijklmnop1234");
  });

  it("strips query strings and fragments from URLs but keeps the path", () => {
    const out = redactTokens("at load (https://media.example/blob/abc.mp4?tk=SECRETTOKEN#frag:12:3)");
    expect(out).toContain("https://media.example/blob/abc.mp4");
    expect(out).not.toContain("SECRETTOKEN");
    expect(out).not.toContain("frag");
  });
});

describe("redactMessage", () => {
  it("keeps the shape of an engine error", () => {
    expect(redactMessage("Cannot read properties of undefined (reading 'displayName')")).toBe(
      "Cannot read properties of undefined (reading 'displayName')",
    );
    expect(redactMessage("Cannot read properties of undefined (reading '0')")).toContain("'0'");
  });

  it("drops quoted input from parse errors (event content, decrypted text)", () => {
    const out = redactMessage(`Unexpected token 'h', "hello this is my private DM" is not valid JSON`);
    expect(out).not.toContain("hello");
    expect(out).not.toContain("private DM");
    // The single offending character is input too.
    expect(out).not.toMatch(/'h'/);
    expect(out).toContain("is not valid JSON");
  });

  it("drops single-quoted and backtick-quoted free text", () => {
    const out = redactMessage("Bad tag 'my secret words here' in `some content`");
    expect(out).not.toContain("secret words");
    expect(out).not.toContain("some content");
  });

  it("drops JSON payloads embedded in a message", () => {
    const out = redactMessage(`Invalid event: {"content":"meet me at noon","pubkey":"${HEX64}"}`);
    expect(out).not.toContain("meet me at noon");
    expect(out).not.toContain(HEX64);
  });

  it("drops long opaque runs such as ciphertext", () => {
    const blob = "QWxhZGRpbjpvcGVuIHNlc2FtZQ".repeat(4);
    expect(redactMessage(`decrypt failed for ${blob}`)).not.toContain(blob);
  });

  it("keeps only the first line and caps the length", () => {
    const out = redactMessage(`first line\nsecond line with content\n${"x ".repeat(400)}`);
    expect(out).toBe("first line");
    expect(redactMessage("word ".repeat(200)).length).toBeLessThanOrEqual(301);
  });

  it("handles non-strings and empty input", () => {
    expect(redactMessage(undefined)).toBe("(no message)");
    expect(redactMessage({ content: "secret" })).toBe("(no message)");
    expect(redactMessage("")).toBe("(no message)");
  });
});

describe("redactStack", () => {
  it("keeps frames and drops the message lines the engine echoes", () => {
    const stack = [
      `SyntaxError: Unexpected token 'h', "hello private text" is not valid JSON`,
      "continued message line with more private text",
      "    at JSON.parse (<anonymous>)",
      "    at parseNote (http://localhost:1420/src/features/spaces/noteParser.ts?t=1731600000000:42:17)",
    ].join("\n");
    const out = redactStack(stack)!;
    expect(out).not.toContain("private text");
    expect(out.split("\n")).toHaveLength(2);
    expect(out).toContain("at parseNote (http://localhost:1420/src/features/spaces/noteParser.ts:42:17)");
  });

  it("understands WebKit and Gecko frames", () => {
    const out = redactStack("some message\nparseNote@http://localhost:1420/src/a.ts:1:2\n@http://localhost:1420/src/b.ts:3:4")!;
    expect(out.split("\n")).toEqual([
      "parseNote@http://localhost:1420/src/a.ts:1:2",
      "@http://localhost:1420/src/b.ts:3:4",
    ]);
  });

  it("keeps deep source paths intact", () => {
    const frame =
      "    at SpaceSettingsModerationPanel (http://localhost:1420/src/features/spaces/settings/moderation/SpaceSettingsModerationPanel.tsx:10:5)";
    expect(redactStack(frame)).toContain("SpaceSettingsModerationPanel.tsx:10:5");
  });

  it("caps the number of frames", () => {
    const stack = Array.from({ length: 80 }, (_, i) => `    at fn${i} (http://localhost/a.js:${i}:1)`).join("\n");
    expect(redactStack(stack)!.split("\n")).toHaveLength(20);
    expect(redactComponentStack(stack)!.split("\n")).toHaveLength(15);
  });

  it("returns undefined when there is nothing usable", () => {
    expect(redactStack(undefined)).toBeUndefined();
    expect(redactStack("just a message, no frames")).toBeUndefined();
    expect(redactStack(42)).toBeUndefined();
  });
});

describe("sanitizeRoute", () => {
  it("replaces dynamic segments with a placeholder", () => {
    expect(sanitizeRoute(`/profile/${HEX64}`)).toBe("/profile/:id");
    expect(sanitizeRoute(`/dm/${HEX64}`)).toBe("/dm/:id");
    expect(sanitizeRoute("/invite/s3cr3t-c0de")).toBe("/invite/:id");
    expect(sanitizeRoute(`/music/album/${HEX64}/my-album`)).toBe("/music/album/:id/:id");
    expect(sanitizeRoute("/note/nevent1qqsabc")).toBe("/note/:id");
  });

  it("keeps static routes and drops query and hash", () => {
    expect(sanitizeRoute("/")).toBe("/");
    expect(sanitizeRoute("/settings?tab=security#top")).toBe("/settings");
    expect(sanitizeRoute("/discover")).toBe("/discover");
    expect(sanitizeRoute(undefined)).toBe("/");
  });
});

describe("sanitizeName", () => {
  it("keeps plain error names and strips anything else", () => {
    expect(sanitizeName("TypeError")).toBe("TypeError");
    expect(sanitizeName("my secret name with spaces")).toBe("mysecretnamewithspaces");
    expect(sanitizeName(undefined)).toBe("Error");
    expect(sanitizeName("x".repeat(200))).toHaveLength(60);
  });
});
