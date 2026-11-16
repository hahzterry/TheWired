import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEADROOM,
  assetType,
  checkBudget,
  collectAssets,
  formatBytes,
  measure,
  otherLazyChunks,
  parseInitialFiles,
  renderMarkdown,
  rerecordBudget,
  stripHash,
  withHeadroom,
} from "../bundleBudget.mjs";

const INDEX_HTML = `<!doctype html><html><head>
<script>var inline = 1;</script>
<script type="module" crossorigin src="/assets/index-bw0IEu3F.js"></script>
<link rel="modulepreload" crossorigin href="/assets/store-CqauBg3W.js">
<link rel="stylesheet" crossorigin href="/assets/index-D3e0i5yR.css">
</head><body></body></html>`;

const dirs = [];
function makeDist(files, indexHtml = INDEX_HTML) {
  const dist = mkdtempSync(path.join(tmpdir(), "bundle-budget-"));
  dirs.push(dist);
  mkdirSync(path.join(dist, "assets"));
  writeFileSync(path.join(dist, "index.html"), indexHtml);
  for (const [name, size] of Object.entries(files)) {
    // Incompressible-ish content so gzip tracks size and the numbers are stable.
    const body = Buffer.alloc(size);
    for (let i = 0; i < size; i++) body[i] = (i * 2654435761) >>> 24;
    writeFileSync(path.join(dist, "assets", name), body);
  }
  return dist;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("stripHash", () => {
  it("removes the 8-char content hash before the extension", () => {
    expect(stripHash("index-bw0IEu3F.js")).toBe("index.js");
    expect(stripHash("redux-toolkit.modern-c0P176zN.js")).toBe("redux-toolkit.modern.js");
    expect(stripHash("download-ne-AAZLj.js")).toBe("download.js");
    expect(stripHash("x-zzkXfaVu.js")).toBe("x.js");
    expect(stripHash("geist-latin-wght-normal-BgDaEnEv.woff2")).toBe("geist-latin-wght-normal.woff2");
  });

  it("leaves names without a hash alone", () => {
    expect(stripHash("splash.css")).toBe("splash.css");
    expect(stripHash("rolldown-runtime.js")).toBe("rolldown-runtime.js");
  });
});

describe("assetType", () => {
  it("classifies by extension", () => {
    expect(assetType("a.js")).toBe("js");
    expect(assetType("a.css")).toBe("css");
    expect(assetType("a.woff2")).toBe("other");
  });
});

describe("parseInitialFiles", () => {
  it("returns the module entry and modulepreloads, not inline scripts or stylesheets", () => {
    expect([...parseInitialFiles(INDEX_HTML)].sort()).toEqual(["index-bw0IEu3F.js", "store-CqauBg3W.js"]);
  });

  it("returns nothing for html without module scripts", () => {
    expect(parseInitialFiles("<html><body></body></html>").size).toBe(0);
  });
});

describe("collectAssets + measure", () => {
  it("measures raw and gzip bytes and rolls them up", () => {
    const dist = makeDist({
      "index-bw0IEu3F.js": 4000,
      "store-CqauBg3W.js": 2000,
      "utils-D8HGDZV3.js": 300,
      "utils-vmJ2PaND.js": 700,
      "index-D3e0i5yR.css": 500,
      "font-BgDaEnEv.woff2": 9000,
    });
    const assets = collectAssets(dist);
    expect(assets[0].file).toBe("font-BgDaEnEv.woff2"); // sorted by raw size
    for (const asset of assets) expect(asset.gzip).toBeGreaterThan(0);

    const m = measure(assets);
    expect(m["total:js"].raw).toBe(7000);
    expect(m["total:js"].files).toBe(4);
    expect(m["total:css"].raw).toBe(500);
    expect(m["initial:js"].raw).toBe(6000); // entry + modulepreload only
    expect(m["chunk:index.js"].raw).toBe(4000);
    // Chunks that share a name once the hash is stripped are one group.
    expect(m["chunk:utils.js"]).toMatchObject({ raw: 1000, files: 2 });
    expect(m["chunk:font.woff2"]).toBeUndefined();
  });
});

/** Asset fixtures: `initial` chunks are the startup payload, the rest are lazy. */
const asset = (file, raw, { gzip = Math.round(raw / 3), initial = false } = {}) => ({
  file,
  name: stripHash(file),
  type: assetType(file),
  raw,
  gzip,
  initial,
});

const BUILD = [
  asset("index-aaaaaaaa.js", 900, { initial: true }),
  asset("react-bbbbbbbb.js", 300, { initial: true }),
  asset("livekitClient-cccccccc.js", 600),
  asset("hls-dddddddd.js", 500),
  asset("safeUrl-eeeeeeee.js", 330), // shared chunk, named after an arbitrary module
  asset("SettingsPage-ffffffff.js", 100),
  asset("index-gggggggg.css", 150),
];

const BUDGET = {
  limits: {
    "initial:js": { raw: 1200, gzip: 400 },
    "total:js": { raw: 2730, gzip: 910 },
    "chunk:livekitClient.js": { raw: 600, gzip: 200 },
    "chunk:hls.js": { raw: 500, gzip: 167 },
  },
  otherChunkLimit: { raw: 330, gzip: 110 },
};

const statusOf = (result, key) => result.rows.find((row) => row.key === key)?.status;

describe("checkBudget", () => {
  it("passes when every line and the lazy ceiling hold", () => {
    const result = checkBudget(BUILD, BUDGET);
    expect(result.ok).toBe(true);
    expect(result.rows.map((row) => row.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
  });

  it("fails when code moves into the startup payload, whatever the chunks are called", () => {
    // The media SDK is statically imported: its chunk becomes a modulepreload.
    const regressed = BUILD.map((a) => (a.name === "livekitClient.js" ? { ...a, initial: true } : a));
    const result = checkBudget(regressed, BUDGET);
    expect(result.ok).toBe(false);
    expect(result.rows.find((row) => row.key === "initial:js")).toMatchObject({ status: "over", over: ["raw", "gzip"] });
  });

  it("fails when the SDK is inlined into the entry: startup grows and the named line matches nothing", () => {
    const regressed = BUILD.filter((a) => a.name !== "livekitClient.js").map((a) =>
      a.file === "index-aaaaaaaa.js" ? asset(a.file, 1500, { initial: true }) : a,
    );
    const result = checkBudget(regressed, BUDGET);
    expect(statusOf(result, "initial:js")).toBe("over");
    expect(statusOf(result, "chunk:livekitClient.js")).toBe("missing");
    expect(result.ok).toBe(false);
  });

  it("fails on a raw-only and on a gzip-only overage and names the metric", () => {
    const raw = checkBudget(BUILD, { limits: { "chunk:hls.js": { raw: 499, gzip: 999 } } });
    expect(raw.rows[0]).toMatchObject({ status: "over", over: ["raw"] });
    const gzip = checkBudget(BUILD, { limits: { "chunk:hls.js": { raw: 999, gzip: 166 } } });
    expect(gzip.rows[0]).toMatchObject({ status: "over", over: ["gzip"] });
    expect(raw.ok || gzip.ok).toBe(false);
  });

  it("a line that matches nothing fails loudly instead of passing", () => {
    const result = checkBudget(BUILD, { limits: { "chunk:store.js": { raw: 10_000, gzip: 10_000 } } });
    expect(result.ok).toBe(false);
    expect(result.rows[0]).toMatchObject({ key: "chunk:store.js", status: "missing", actual: null });
  });

  it("holds unlisted lazy chunks to the per-file ceiling and names the offender", () => {
    const grown = [...BUILD, asset("NewFeature-hhhhhhhh.js", 400)];
    const result = checkBudget(grown, { ...BUDGET, limits: { ...BUDGET.limits, "total:js": { raw: 9999, gzip: 9999 } } });
    expect(result.ok).toBe(false);
    expect(result.rows.find((row) => row.key === "otherChunkLimit")).toMatchObject({
      status: "over",
      offenders: ["NewFeature-hhhhhhhh.js"],
    });
  });

  it("a shared chunk renamed by an unrelated import change neither fails nor drops a line", () => {
    // Same bytes, new auto-generated name: nothing in the budget refers to it.
    const renamed = BUILD.map((a) => (a.name === "safeUrl.js" ? asset("dateUtils-eeeeeeee.js", 330) : a));
    const result = checkBudget(renamed, BUDGET);
    expect(result.ok).toBe(true);
    expect(result.rows.map((row) => row.key)).toEqual(checkBudget(BUILD, BUDGET).rows.map((row) => row.key));
  });

  it("the ceiling is per file: two chunks that share an auto-generated name are not summed", () => {
    const twins = [...BUILD, asset("utils-iiiiiiii.js", 200), asset("utils-jjjjjjjj.js", 200)];
    const result = checkBudget(twins, { otherChunkLimit: { raw: 330, gzip: 110 }, limits: BUDGET.limits });
    expect(statusOf(result, "otherChunkLimit")).toBe("ok");
  });

  it("does not hold startup chunks or named lazy chunks to the ceiling", () => {
    // index (900), react (300, initial), livekitClient (600) and hls (500) are all above 330.
    expect(statusOf(checkBudget(BUILD, BUDGET), "otherChunkLimit")).toBe("ok");
    expect(otherLazyChunks(BUILD, BUDGET.limits).map((a) => a.name)).toEqual(["safeUrl.js", "SettingsPage.js"]);
  });
});

describe("rerecordBudget", () => {
  it("re-records the existing lines with headroom, tightest on the startup payload", () => {
    const next = rerecordBudget(BUILD, { limits: { "initial:js": {}, "total:js": {}, "chunk:hls.js": {} }, otherChunkLimit: {} });
    expect(Object.keys(next.limits)).toEqual(["initial:js", "total:js", "chunk:hls.js"]);
    expect(next.limits["initial:js"].raw).toBe(withHeadroom(1200, HEADROOM.initial));
    expect(next.limits["total:js"].raw).toBe(withHeadroom(2730, HEADROOM.line));
    expect(HEADROOM.initial).toBeLessThan(HEADROOM.line);
    // livekitClient has no line here, so it sets the ceiling.
    expect(next.otherChunkLimit.raw).toBe(withHeadroom(600, HEADROOM.otherChunk));
    expect(checkBudget(BUILD, next).ok).toBe(true);
  });

  it("never invents per-chunk lines", () => {
    const next = rerecordBudget(BUILD, { limits: { "total:js": {} } });
    expect(Object.keys(next.limits)).toEqual(["total:js"]);
    expect(next.otherChunkLimit).toBeUndefined();
  });

  it("refuses to record a line that matches nothing", () => {
    expect(() => rerecordBudget(BUILD, { limits: { "chunk:store.js": {} } })).toThrow(/chunk:store\.js/);
  });

  it("rounds headroom up to a whole kilobyte", () => {
    expect(withHeadroom(1000, 0.03)).toBe(2048);
    expect(withHeadroom(1024, 0)).toBe(1024);
  });
});

describe("the committed budget", () => {
  const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const budget = JSON.parse(readFileSync(path.join(clientDir, "bundle-budget.json"), "utf8"));

  function sourceFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it("has a tight startup line, totals and a ceiling for unlisted lazy chunks", () => {
    expect(Object.keys(budget.limits)).toEqual(expect.arrayContaining(["initial:js", "total:js", "total:css"]));
    expect(budget.otherChunkLimit.raw).toBeGreaterThan(0);
    // Startup is a fraction of the app; a limit near the total would guard nothing.
    expect(budget.limits["initial:js"].raw).toBeLessThan(budget.limits["total:js"].raw / 2);
  });

  it("names only chunks we name ourselves: every chunk line is the target of an import() in src", () => {
    const sources = sourceFiles(path.join(clientDir, "src")).map((file) => readFileSync(file, "utf8"));
    const chunkLines = Object.keys(budget.limits).filter((key) => key.startsWith("chunk:"));
    expect(chunkLines.length).toBeGreaterThan(0);
    for (const key of chunkLines) {
      const name = key.slice("chunk:".length).replace(/\.js$/, "");
      const dynamicImport = new RegExp(`import\\(\\s*["'](?:[^"']*/)?${name}(?:\\.js)?["']\\s*\\)`);
      expect(sources.some((source) => dynamicImport.test(source)), `${key}: no import("…${name}") in src`).toBe(true);
    }
  });
});

describe("rendering", () => {
  it("formats bytes", () => {
    expect(formatBytes(500)).toBe("0.5 kB");
    expect(formatBytes(999_999)).toBe("1000.0 kB");
    expect(formatBytes(2_858_858)).toBe("2.86 MB");
  });

  it("marks over-budget and missing lines in the markdown summary", () => {
    const assets = [asset("index-aaaaaaaa.js", 2000, { gzip: 1000, initial: true }), asset("Big-bbbbbbbb.js", 900, { gzip: 300 })];
    const result = checkBudget(assets, {
      limits: { "initial:js": { raw: 1000, gzip: 2000 }, "chunk:gone.js": { raw: 1, gzip: 1 } },
      otherChunkLimit: { raw: 500, gzip: 500 },
    });
    const md = renderMarkdown({ assets, result });
    expect(md).toContain("**Budget check failed.**");
    expect(md).toContain("| `initial:js` | 2.0 kB (200.0%) | 1.0 kB | 1.0 kB (50.0%) | 2.0 kB | **over** (raw) |");
    expect(md).toContain("| `chunk:gone.js` | - | 0.0 kB | - | 0.0 kB | **missing**: nothing in the build matches |");
    expect(md).toContain("| largest other lazy chunk | 0.9 kB (180.0%) | 0.5 kB | 0.3 kB (60.0%) | 0.5 kB | **over** (raw): `Big-bbbbbbbb.js` |");
    expect(md).toContain("| `index-aaaaaaaa.js` | 2.0 kB | 1.0 kB | yes |");
  });
});

describe("bundle-size.mjs CLI", () => {
  const toolsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

  /** A throwaway "client" dir: the CLI resolves dist/ and the budget next to tools/. */
  function makeClient({ files, budget }) {
    const dir = mkdtempSync(path.join(tmpdir(), "bundle-cli-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "tools"));
    for (const file of ["bundle-size.mjs", "bundleBudget.mjs"]) {
      copyFileSync(path.join(toolsDir, file), path.join(dir, "tools", file));
    }
    writeFileSync(path.join(dir, "bundle-budget.json"), JSON.stringify(budget));
    if (files) {
      mkdirSync(path.join(dir, "dist", "assets"), { recursive: true });
      writeFileSync(path.join(dir, "dist", "index.html"), INDEX_HTML);
      for (const [name, size] of Object.entries(files)) {
        writeFileSync(path.join(dir, "dist", "assets", name), Buffer.alloc(size, "a"));
      }
    }
    return dir;
  }

  function run(dir, args = [], env = {}) {
    return spawnSync(process.execPath, [path.join(dir, "tools", "bundle-size.mjs"), ...args], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "", ...env },
    });
  }

  // index + store are the startup payload (see INDEX_HTML); lazy is not.
  const files = { "index-bw0IEu3F.js": 5000, "store-CqauBg3W.js": 1000, "lazy-AbCdEfGh.js": 3000 };
  const passing = {
    limits: { "initial:js": { raw: 6000, gzip: 6000 }, "chunk:lazy.js": { raw: 3000, gzip: 3000 } },
    otherChunkLimit: { raw: 100, gzip: 100 },
  };

  it("exits 2 with a hint when there is no build output", () => {
    const result = run(makeClient({ budget: { limits: {} } }));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("pnpm build");
  });

  it("exits 0 and writes the job summary when within budget", () => {
    const dir = makeClient({ files, budget: passing });
    const summary = path.join(dir, "summary.md");
    const result = run(dir, [], { GITHUB_STEP_SUMMARY: summary });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("index-bw0IEu3F.js");
    expect(result.stdout).toContain("Bundle is within budget.");
    expect(readFileSync(summary, "utf8")).toContain("## Client bundle size");
  });

  it("exits 1 and names the line when the startup payload grows past its budget", () => {
    const dir = makeClient({ files, budget: { limits: { "initial:js": { raw: 5999, gzip: 6000 } } } });
    const result = run(dir, [], { GITHUB_ACTIONS: "true" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error title=Bundle budget::initial:js is over its raw budget");
  });

  it("exits 1 when a line matches nothing in the build", () => {
    const dir = makeClient({ files, budget: { limits: { "chunk:store-old.js": { raw: 9999, gzip: 9999 } } } });
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("missing  chunk:store-old.js");
    expect(result.stderr).toContain("chunk:store-old.js matches nothing in the build");
  });

  it("exits 1 and names the file when an unlisted lazy chunk is over the ceiling", () => {
    const dir = makeClient({ files, budget: { limits: {}, otherChunkLimit: { raw: 2999, gzip: 9999 } } });
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("lazy chunk over the raw ceiling for unlisted chunks: lazy-AbCdEfGh.js");
  });

  it("--update re-records the existing lines so the same build passes, and adds none", () => {
    const dir = makeClient({
      files,
      budget: { limits: { "initial:js": { raw: 1, gzip: 1 } }, otherChunkLimit: { raw: 1, gzip: 1 } },
    });
    expect(run(dir).status).toBe(1);
    expect(run(dir, ["--update"]).status).toBe(0);
    const budget = JSON.parse(readFileSync(path.join(dir, "bundle-budget.json"), "utf8"));
    expect(Object.keys(budget.limits)).toEqual(["initial:js"]);
    expect(budget.limits["initial:js"].raw).toBeGreaterThanOrEqual(6000);
    expect(budget.otherChunkLimit.raw).toBeGreaterThanOrEqual(3000);
    expect(run(dir).status).toBe(0);
  });

  it("--update refuses a line that matches nothing", () => {
    const dir = makeClient({ files, budget: { limits: { "chunk:gone.js": { raw: 1, gzip: 1 } } } });
    const result = run(dir, ["--update"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"chunk:gone.js" matches nothing');
  });
});
