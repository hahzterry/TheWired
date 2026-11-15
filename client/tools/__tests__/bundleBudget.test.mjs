// @vitest-environment node
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assetType,
  checkBudget,
  collectAssets,
  formatBytes,
  measure,
  parseInitialFiles,
  proposeBudget,
  renderMarkdown,
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

describe("checkBudget", () => {
  const measurements = {
    "total:js": { raw: 1000, gzip: 400, files: 2 },
    "chunk:index.js": { raw: 800, gzip: 300, files: 1 },
    "chunk:lazy.js": { raw: 200, gzip: 100, files: 1 },
  };

  it("passes when everything is within its line", () => {
    const result = checkBudget(measurements, {
      defaultChunkLimit: { raw: 500, gzip: 200 },
      limits: { "total:js": { raw: 1000, gzip: 400 }, "chunk:index.js": { raw: 900, gzip: 350 } },
    });
    expect(result.ok).toBe(true);
    expect(result.rows.map((r) => r.status)).toEqual(["ok", "ok"]);
  });

  it("fails on a raw overage and names the metric", () => {
    const result = checkBudget(measurements, {
      limits: { "chunk:index.js": { raw: 799, gzip: 350 } },
    });
    expect(result.ok).toBe(false);
    expect(result.rows[0]).toMatchObject({ key: "chunk:index.js", status: "over", over: ["raw"] });
  });

  it("fails on a gzip-only overage", () => {
    const result = checkBudget(measurements, {
      limits: { "chunk:index.js": { raw: 900, gzip: 299 } },
    });
    expect(result.rows[0].over).toEqual(["gzip"]);
    expect(result.ok).toBe(false);
  });

  it("holds unlisted chunks to the default limit (catches a new large chunk)", () => {
    const result = checkBudget(measurements, {
      defaultChunkLimit: { raw: 150, gzip: 150 },
      limits: { "chunk:index.js": { raw: 900, gzip: 350 } },
    });
    expect(result.ok).toBe(false);
    const over = result.rows.find((r) => r.status === "over");
    expect(over).toMatchObject({ key: "chunk:lazy.js", unlisted: true, over: ["raw"] });
  });

  it("does not apply the default limit to totals or listed chunks", () => {
    const result = checkBudget(measurements, {
      defaultChunkLimit: { raw: 500, gzip: 200 },
      limits: { "chunk:index.js": { raw: 900, gzip: 350 } },
    });
    expect(result.ok).toBe(true);
  });

  it("reports a line that matches nothing as stale without failing", () => {
    const result = checkBudget(measurements, {
      limits: { "chunk:gone.js": { raw: 1, gzip: 1 } },
    });
    expect(result.ok).toBe(true);
    expect(result.rows[0]).toMatchObject({ key: "chunk:gone.js", status: "stale", actual: null });
  });
});

describe("proposeBudget", () => {
  it("lists totals plus only the chunks above the default limit, with headroom", () => {
    const budget = proposeBudget(
      {
        "total:js": { raw: 100_000, gzip: 40_000, files: 2 },
        "initial:js": { raw: 90_000, gzip: 35_000, files: 1 },
        "chunk:index.js": { raw: 90_000, gzip: 35_000, files: 1 },
        "chunk:small.js": { raw: 10_000, gzip: 5_000, files: 1 },
      },
      { headroom: 0.03, defaultChunkLimit: { raw: 50_000, gzip: 20_000 } },
    );
    expect(Object.keys(budget.limits)).toEqual(["total:js", "initial:js", "chunk:index.js"]);
    expect(budget.limits["chunk:index.js"].raw).toBe(withHeadroom(90_000, 0.03));
    expect(budget.limits["chunk:index.js"].raw).toBeGreaterThan(90_000);
    // The proposed budget always passes for the build it came from.
    expect(
      checkBudget(
        { "chunk:index.js": { raw: 90_000, gzip: 35_000 }, "chunk:small.js": { raw: 10_000, gzip: 5_000 } },
        budget,
      ).rows.filter((r) => r.status === "over"),
    ).toEqual([]);
  });

  it("rounds headroom up to a whole kilobyte", () => {
    expect(withHeadroom(1000, 0.03)).toBe(2048);
    expect(withHeadroom(1024, 0)).toBe(1024);
  });
});

describe("rendering", () => {
  it("formats bytes", () => {
    expect(formatBytes(500)).toBe("0.5 kB");
    expect(formatBytes(999_999)).toBe("1000.0 kB");
    expect(formatBytes(2_858_858)).toBe("2.86 MB");
  });

  it("marks over-budget and stale lines in the markdown summary", () => {
    const assets = [{ file: "index-aaaaaaaa.js", raw: 2000, gzip: 1000, initial: true }];
    const result = checkBudget(
      { "chunk:index.js": { raw: 2000, gzip: 1000, files: 1 } },
      { limits: { "chunk:index.js": { raw: 1000, gzip: 2000 }, "chunk:gone.js": { raw: 1, gzip: 1 } } },
    );
    const md = renderMarkdown({ assets, result });
    expect(md).toContain("**Over budget.**");
    expect(md).toContain("| `chunk:index.js` | 2.0 kB (200.0%) | 1.0 kB | 1.0 kB (50.0%) | 2.0 kB | **over** (raw) |");
    expect(md).toContain("| `chunk:gone.js` | - |");
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

  const files = { "index-bw0IEu3F.js": 5000, "store-CqauBg3W.js": 1000 };

  it("exits 2 with a hint when there is no build output", () => {
    const result = run(makeClient({ budget: { limits: {} } }));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("pnpm build");
  });

  it("exits 0 and writes the job summary when within budget", () => {
    const dir = makeClient({ files, budget: { limits: { "chunk:index.js": { raw: 5000, gzip: 5000 } } } });
    const summary = path.join(dir, "summary.md");
    const result = run(dir, [], { GITHUB_STEP_SUMMARY: summary });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("index-bw0IEu3F.js");
    expect(result.stdout).toContain("Bundle is within budget.");
    expect(readFileSync(summary, "utf8")).toContain("## Client bundle size");
  });

  it("exits 1 and names the line when a chunk grows past its budget", () => {
    const dir = makeClient({ files, budget: { limits: { "chunk:index.js": { raw: 4999, gzip: 5000 } } } });
    const result = run(dir, [], { GITHUB_ACTIONS: "true" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error title=Bundle budget::chunk:index.js is over its raw budget");
  });

  it("--update rewrites the budget so the same build passes", () => {
    const dir = makeClient({
      files,
      budget: { defaultChunkLimit: { raw: 2000, gzip: 2000 }, limits: { "chunk:index.js": { raw: 1, gzip: 1 } } },
    });
    expect(run(dir).status).toBe(1);
    expect(run(dir, ["--update"]).status).toBe(0);
    const budget = JSON.parse(readFileSync(path.join(dir, "bundle-budget.json"), "utf8"));
    expect(budget.limits["chunk:index.js"].raw).toBeGreaterThanOrEqual(5000);
    expect(budget.limits["chunk:store.js"]).toBeUndefined(); // under the default limit
    expect(run(dir).status).toBe(0);
  });
});
