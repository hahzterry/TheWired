/**
 * `lib/nostr/login/*` and `lib/nostr/pipeline/*` are reached only through
 * their entry files, `loginFlow.ts` and `eventPipeline.ts`.
 *
 * Each entry imports its `evaluationOrder.ts` first, which fixes the order the
 * module's dependencies evaluate in. Both modules sit in an import cycle with
 * the store, so a file that imports `login/performLogin` or `pipeline/ingest`
 * directly skips that pin and can evaluate the cycle in a different order
 * (an "X is not initialized" error at startup, or none until an unrelated
 * import moves). This test fails with the offending file and specifier.
 *
 * It covers every `.ts` / `.tsx` under `src`, tests included. A unit test for
 * one of the internal modules belongs inside that folder (e.g.
 * `lib/nostr/login/__tests__/`), where the rule does not apply.
 */
import { describe, it, expect } from "vitest";

// Vite leaves the importing file out of its own glob, so the fixture strings
// further down are not scanned as real imports.
const sources = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Folder (relative to `src`) → the one file outside it that may import from it. */
const GUARDED: Record<string, string> = {
  "lib/nostr/login/": "lib/nostr/loginFlow.ts",
  "lib/nostr/pipeline/": "lib/nostr/eventPipeline.ts",
};

/**
 * Every place a module specifier can appear: `from "x"`, `import "x"`,
 * `import("x")`, `require("x")`, and the vitest helpers that take one.
 */
const SPECIFIER =
  /(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\(|\b(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*\()\s*["'`]([^"'`\n]+)["'`]/g;

/** `/src/a/b.ts` → `a/b.ts` */
function toSrcRelative(globKey: string): string {
  return globKey.replace(/^\/src\//, "");
}

/** Resolve a specifier to a path relative to `src`, or null for a package. */
function resolveSpecifier(specifier: string, importer: string): string | null {
  let parts: string[];
  if (specifier.startsWith("@/")) {
    parts = specifier.slice(2).split("/");
  } else if (specifier.startsWith(".")) {
    parts = [...importer.split("/").slice(0, -1), ...specifier.split("/")];
  } else {
    return null;
  }
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function findViolations(files: Record<string, string>): string[] {
  const violations: string[] = [];
  for (const [key, text] of Object.entries(files)) {
    const importer = toSrcRelative(key);
    for (const match of text.matchAll(SPECIFIER)) {
      const target = resolveSpecifier(match[1], importer);
      if (!target) continue;
      for (const [folder, entry] of Object.entries(GUARDED)) {
        // `lib/nostr/login` itself (no trailing slash) would be a folder import.
        const inside = `${target}/`.startsWith(folder);
        if (!inside) continue;
        if (importer.startsWith(folder) || importer === entry) continue;
        violations.push(`${importer} imports "${match[1]}" — import from ${entry} instead`);
      }
    }
  }
  return violations.sort();
}

describe("lib/nostr/login and lib/nostr/pipeline are imported only through their entry files", () => {
  it("scans the client source", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(500);
    for (const entry of Object.values(GUARDED)) {
      expect(sources[`/src/${entry}`], entry).toBeTypeOf("string");
    }
  });

  it("sees the imports it is meant to police (the entry files' own)", () => {
    // The entries are the allowed importers. Scanning them as if they were any
    // other file must report them: otherwise the scan matches nothing.
    for (const [folder, entry] of Object.entries(GUARDED)) {
      const asOutsider = findViolations({
        "/src/lib/nostr/someOtherFile.ts": sources[`/src/${entry}`],
      });
      expect(asOutsider.length, entry).toBeGreaterThan(0);
      expect(asOutsider.every((v) => v.includes(`./${folder.split("/")[2]}/`)), entry).toBe(true);
    }
  });

  it("catches each import form, relative or aliased", () => {
    const files = {
      "/src/features/x/a.ts": `import { performLogin } from "@/lib/nostr/login/performLogin";`,
      "/src/features/x/b.ts": `export { createIngest } from "../../lib/nostr/pipeline/ingest";`,
      "/src/features/x/c.ts": `const m = await import("@/lib/nostr/pipeline/batching");`,
      "/src/features/x/d.test.ts": `vi.mock("@/lib/nostr/login/state", () => ({}));`,
      "/src/lib/nostr/e.ts": `import "./login/evaluationOrder";`,
      "/src/lib/nostr/login/f.ts": `import { computeSweep } from "../pipeline/sweep";`,
      // allowed
      "/src/lib/nostr/login/g.ts": `import { loginState } from "./state";`,
      "/src/lib/nostr/pipeline/__tests__/h.test.ts": `import { computeSweep } from "../sweep";`,
      "/src/features/x/i.ts": `import { performLogin } from "@/lib/nostr/loginFlow";`,
      "/src/features/identity/login/j.ts": `import { k } from "./k";`,
      "/src/lib/nostr/loginFlow.ts": `export { performLogin } from "./login/performLogin";`,
    };
    expect(findViolations(files).map((v) => v.split(" imports ")[0])).toEqual([
      "features/x/a.ts",
      "features/x/b.ts",
      "features/x/c.ts",
      "features/x/d.test.ts",
      "lib/nostr/e.ts",
      "lib/nostr/login/f.ts",
    ]);
  });

  it("has no import that goes around an entry file", () => {
    expect(findViolations(sources)).toEqual([]);
  });
});
