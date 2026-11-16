/**
 * Import rules that keep heavy code out of the startup bundle.
 *
 * A single static import in the wrong file silently puts hundreds of kilobytes
 * back in the entry chunk: the build still passes and nothing looks broken.
 * These checks read the source and fail on the import itself, naming the file.
 *
 * Type-only imports are fine everywhere (they are erased), and so are dynamic
 * `import()` calls: both are skipped.
 */
import { describe, it, expect } from "vitest";

// Every source file as text (tests and type declarations excluded).
const RAW = import.meta.glob<string>(
  ["../**/*.{ts,tsx}", "!../**/__tests__/**", "!../**/*.test.{ts,tsx}", "!../**/*.d.ts"],
  { query: "?raw", import: "default", eager: true },
);

const FILES = Object.entries(RAW).map(([key, text]) => ({
  rel: key.replace(/^\.\.\//, ""),
  text,
}));

/** Static `import ... from "<spec>"` statements that bring in a runtime value. */
function staticValueImports(text: string): Array<{ spec: string; statement: string }> {
  const found: Array<{ spec: string; statement: string }> = [];
  const re = /^[ \t]*(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']/gm;
  for (const m of text.matchAll(re)) {
    const [statement, , typeOnly, clause, spec] = m;
    if (typeOnly) continue;
    // `import { type A, type B } from` brings in no value either.
    const named = clause.match(/^\{([\s\S]*)\}$/);
    if (named) {
      const names = named[1].split(",").map((n) => n.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith("type "))) continue;
    }
    found.push({ spec, statement: statement.trim().replace(/\s+/g, " ") });
  }
  // Side-effect imports: `import "x";`
  for (const m of text.matchAll(/^[ \t]*import\s*["']([^"']+)["']/gm)) {
    found.push({ spec: m[1], statement: m[0].trim() });
  }
  return found;
}

/** Dynamic `import("<spec>")` calls. */
function dynamicImports(text: string): string[] {
  return [...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
}

/** Files (outside `allowed`) with a dynamic import of a matching module. */
function dynamicOffenders(matches: (spec: string) => boolean, allowed: (rel: string) => boolean): string[] {
  const out: string[] = [];
  for (const { rel, text } of FILES) {
    if (allowed(rel)) continue;
    for (const spec of dynamicImports(text)) {
      if (matches(spec)) out.push(`${rel}: import("${spec}")`);
    }
  }
  return out;
}

function offenders(matches: (spec: string) => boolean, allowed: (rel: string) => boolean): string[] {
  const out: string[] = [];
  for (const { rel, text } of FILES) {
    if (allowed(rel)) continue;
    for (const imp of staticValueImports(text)) {
      if (matches(imp.spec)) out.push(`${rel}: ${imp.statement}`);
    }
  }
  return out;
}

describe("the import scanner itself", () => {
  it("tells value imports from type-only and dynamic ones", () => {
    const sample = [
      'import Hls from "hls.js";',
      'import type HlsType from "hls.js";',
      'import { type Room, type Track } from "livekit-client";',
      'import { Room, type Track } from "livekit-client";',
      'const mod = await import("hls.js");',
      'export { a } from "./a";',
      'export type { B } from "./b";',
      'import "./side-effect";',
      "import {",
      "  connectToRoom,",
      "  type ConnectOptions,",
      '} from "@/lib/webrtc/livekitClient";',
    ].join("\n");

    expect(staticValueImports(sample).map((i) => i.spec)).toEqual([
      "hls.js",
      "livekit-client",
      "./a",
      "@/lib/webrtc/livekitClient",
      "./side-effect",
    ]);
  });

  it("finds dynamic imports, and only those", () => {
    const sample = [
      'import Hls from "hls.js";',
      'const mod = await import("hls.js");',
      "const other = await import(",
      '  "./livekitClient"',
      ");",
      'const worker = new URL("./w.ts", import.meta.url);',
    ].join("\n");
    expect(dynamicImports(sample)).toEqual(["hls.js", "./livekitClient"]);
  });

  it("sees the app's source", () => {
    expect(FILES.length).toBeGreaterThan(400);
    expect(FILES.some((f) => f.rel === "app/App.tsx")).toBe(true);
  });
});

describe("heavy libraries stay behind dynamic imports", () => {
  it("hls.js is never imported statically (use lib/media/hls.ts)", () => {
    expect(offenders((s) => s === "hls.js", () => false)).toEqual([]);
  });

  // One loader per heavy library means one place that handles a download that
  // failed (and retries it), instead of each caller growing its own.
  it("hls.js is loaded in one place: everything else goes through lib/media/hls.ts", () => {
    expect(dynamicOffenders((s) => s === "hls.js", (rel) => rel === "lib/media/hls.ts")).toEqual([]);
  });

  it("the room module is loaded in one place: the facade (lib/webrtc/livekit.ts)", () => {
    // The call debug dump (a `wiredDebug` command) reads the room directly.
    const allowed = new Set(["lib/webrtc/livekit.ts", "lib/debug/callTracker.ts"]);
    expect(dynamicOffenders((s) => /(^|\/)livekitClient$/.test(s), (rel) => allowed.has(rel))).toEqual([]);
  });

  it("music-metadata is loaded in one place: the track file parser", () => {
    expect(
      dynamicOffenders((s) => s === "music-metadata", (rel) => rel === "features/music/trackFileParser.ts"),
    ).toEqual([]);
  });

  it("livekit-client is value-imported only by the room module and its E2EE helpers", () => {
    const allowed = new Set([
      "lib/webrtc/livekitClient.ts",
      "lib/webrtc/e2ee/NostrKeyProvider.ts",
      "lib/webrtc/e2ee/e2eeWorker.ts",
    ]);
    expect(offenders((s) => s === "livekit-client" || s.startsWith("livekit-client/"), (rel) => allowed.has(rel))).toEqual(
      [],
    );
  });

  it("the room module and E2EE session are reached only through the facade (lib/webrtc/livekit.ts)", () => {
    const heavy = /(^|\/)(livekitClient|e2ee\/session|e2ee\/NostrKeyProvider|e2ee\/e2eeWorker|e2ee\/index|e2ee)$/;
    expect(
      offenders(
        (s) => heavy.test(s) && (s.includes("webrtc") || s.startsWith("./") || s.startsWith("../")),
        (rel) => rel.startsWith("lib/webrtc/"),
      ),
    ).toEqual([]);
  });

  it("music-metadata is never imported statically (parsers load when a file is picked)", () => {
    expect(offenders((s) => s === "music-metadata", () => false)).toEqual([]);
  });

  it("recharts stays inside the chart artifact", () => {
    expect(offenders((s) => s === "recharts", (rel) => rel === "features/ai/artifacts/ChartArtifact.tsx")).toEqual([]);
  });

  it("the markdown pipeline stays inside the two markdown renderers", () => {
    const libs = new Set(["react-markdown", "rehype-highlight", "remark-gfm", "remark-breaks", "highlight.js", "marked"]);
    const allowed = new Set(["features/longform/ArticleMarkdown.tsx", "features/ai/markdown/AIMarkdown.tsx"]);
    expect(
      offenders(
        (s) => libs.has(s) || s.startsWith("highlight.js/"),
        (rel) => allowed.has(rel) || rel.startsWith("features/ai/"),
      ),
    ).toEqual([]);
  });

  it("the article renderer is imported statically only by its lazy wrapper", () => {
    expect(
      offenders(
        (s) => /(^|\/)ArticleMarkdown$/.test(s),
        () => false,
      ),
    ).toEqual([]);
  });

  it("dnd-kit stays inside the drag-and-drop channel tree", () => {
    expect(offenders((s) => s.startsWith("@dnd-kit/"), (rel) => rel === "features/spaces/ChannelTreeDnd.tsx")).toEqual([]);
  });

  it("the rich text editor (tiptap) stays inside its own module", () => {
    expect(
      offenders(
        (s) => s.startsWith("@tiptap/") || s === "tiptap-markdown",
        (rel) => rel === "features/longform/RichArticleEditor.tsx",
      ),
    ).toEqual([]);
  });
});

describe("the app shell reaches lazy routes only through their lazy wrappers", () => {
  const SHELL = ["app/App.tsx", "app/Layout.tsx", "components/layout/Sidebar.tsx", "components/layout/RightPanel.tsx"];
  const LAZY_ONLY = [
    "features/settings/SettingsPage",
    "features/discover/DiscoverPage",
    "features/dm/DMView",
    "features/dm/DMSidebar",
    "features/dm/DMContactPanel",
    "features/relay/RelayStatusPanel",
    "features/profile/ProfilePage",
    "features/profile/NoteThreadPage",
    "features/profile/ProfileSidePanel",
    "features/longform/ArticlePage",
    "features/longform/ArticleEditorPage",
    "features/music/MusicRouter",
    "features/music/MusicSidebar",
    "features/music/MusicLinkResolver",
    "features/music/QueueContent",
    "features/music/NowPlayingDetail",
    "features/music/playbackBar/FloatingPlaybackBar",
    "features/onboarding/ProfileWizard",
    "features/onboarding/AppTour",
    "features/calling/CallController",
    "features/ai/AIChatView",
    "features/ai/AISidebar",
    "features/ai/artifacts/ArtifactsPanel",
    "features/discover/SpacePreviewPanel",
    "features/spaces/JoinSpaceModal",
    "features/settings/AppSettingsTab",
  ];

  it.each(SHELL)("%s has no static import of a lazy route", (rel) => {
    const file = FILES.find((f) => f.rel === rel);
    expect(file, `${rel} not found`).toBeDefined();
    const bad = staticValueImports(file!.text)
      .filter((imp) => LAZY_ONLY.some((target) => imp.spec.endsWith(target)))
      .map((imp) => imp.statement);
    expect(bad).toEqual([]);
  });
});
