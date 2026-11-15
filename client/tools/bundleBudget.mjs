/**
 * Bundle-size accounting for the client production build. Pure functions plus
 * one directory reader, so the CLI (bundle-size.mjs) stays a thin shell and
 * the logic is unit-testable without running a build.
 *
 * Vocabulary
 *   asset    one emitted file under dist/assets
 *   group    assets that share a name once the content hash is stripped
 *            (`index-bw0IEu3F.js` -> `index.js`); a group is what a budget
 *            line refers to, because hashes change on every build
 *   initial  the JS the browser fetches before first paint: the entry script
 *            in index.html plus every <link rel="modulepreload">
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

/** Rolldown/Vite content hashes: 8 url-safe base64 chars before the extension. */
const HASH_SUFFIX = /-[A-Za-z0-9_-]{8}(?=\.[a-z0-9]+$)/;

export function stripHash(fileName) {
  return fileName.replace(HASH_SUFFIX, "");
}

export function assetType(fileName) {
  if (fileName.endsWith(".js")) return "js";
  if (fileName.endsWith(".css")) return "css";
  return "other";
}

/** Entry script + modulepreload hrefs from the built index.html, as base names. */
export function parseInitialFiles(indexHtml) {
  const files = new Set();
  const tags = indexHtml.match(/<(?:script|link)\b[^>]*>/g) ?? [];
  for (const tag of tags) {
    const isEntry = /^<script\b/.test(tag) && /type="module"/.test(tag);
    const isPreload = /^<link\b/.test(tag) && /rel="modulepreload"/.test(tag);
    if (!isEntry && !isPreload) continue;
    const url = tag.match(/\b(?:src|href)="([^"]+)"/)?.[1];
    if (url && url.endsWith(".js")) files.add(path.posix.basename(url));
  }
  return files;
}

/** Read every file under `<distDir>/assets` and measure raw + gzip bytes. */
export function collectAssets(distDir) {
  const assetsDir = path.join(distDir, "assets");
  const initial = parseInitialFiles(readFileSync(path.join(distDir, "index.html"), "utf8"));
  return readdirSync(assetsDir)
    .filter((file) => statSync(path.join(assetsDir, file)).isFile())
    .map((file) => {
      const bytes = readFileSync(path.join(assetsDir, file));
      return {
        file,
        name: stripHash(file),
        type: assetType(file),
        raw: bytes.length,
        gzip: gzipSync(bytes, { level: 9 }).length,
        initial: initial.has(file),
      };
    })
    .sort((a, b) => b.raw - a.raw);
}

function add(target, asset) {
  target.raw += asset.raw;
  target.gzip += asset.gzip;
  target.files += 1;
}

/**
 * Roll assets up into the measurements budgets are written against:
 * `total:js`, `total:css`, `initial:js`, and one `chunk:<name>` per JS group.
 */
export function measure(assets) {
  const measurements = {
    "total:js": { raw: 0, gzip: 0, files: 0 },
    "total:css": { raw: 0, gzip: 0, files: 0 },
    "initial:js": { raw: 0, gzip: 0, files: 0 },
  };
  for (const asset of assets) {
    if (asset.type === "css") add(measurements["total:css"], asset);
    if (asset.type !== "js") continue;
    add(measurements["total:js"], asset);
    if (asset.initial) add(measurements["initial:js"], asset);
    const key = `chunk:${asset.name}`;
    measurements[key] ??= { raw: 0, gzip: 0, files: 0 };
    add(measurements[key], asset);
  }
  return measurements;
}

/**
 * Compare measurements with a budget.
 *
 * budget = {
 *   limits: { "<key>": { raw, gzip } },      explicit lines
 *   defaultChunkLimit: { raw, gzip },        every chunk group without a line
 * }
 *
 * A limit that names something the build no longer emits is reported as
 * `stale` (not a failure): the chunk was renamed or removed and the line
 * should be dropped.
 */
export function checkBudget(measurements, budget) {
  const rows = [];
  const limits = budget.limits ?? {};

  for (const [key, limit] of Object.entries(limits)) {
    const actual = measurements[key];
    if (!actual) {
      rows.push({ key, limit, actual: null, status: "stale", over: [] });
      continue;
    }
    const over = ["raw", "gzip"].filter((metric) => actual[metric] > limit[metric]);
    rows.push({ key, limit, actual, status: over.length ? "over" : "ok", over });
  }

  const fallback = budget.defaultChunkLimit;
  if (fallback) {
    for (const [key, actual] of Object.entries(measurements)) {
      if (!key.startsWith("chunk:") || key in limits) continue;
      const over = ["raw", "gzip"].filter((metric) => actual[metric] > fallback[metric]);
      if (over.length) rows.push({ key, limit: fallback, actual, status: "over", over, unlisted: true });
    }
  }

  return { rows, ok: rows.every((row) => row.status !== "over") };
}

/** Round up to the next multiple of `step` after adding `headroom` (0.03 = 3%). */
export function withHeadroom(bytes, headroom, step = 1024) {
  return Math.ceil((bytes * (1 + headroom)) / step) * step;
}

/**
 * Build a budget from current measurements: totals and the initial payload
 * always get a line; a chunk group gets its own line only when it is already
 * above the default limit (everything else stays under the default).
 */
export function proposeBudget(measurements, { headroom = 0.03, defaultChunkLimit }) {
  const limits = {};
  for (const [key, actual] of Object.entries(measurements)) {
    const isChunk = key.startsWith("chunk:");
    const overDefault =
      isChunk && (actual.raw > defaultChunkLimit.raw || actual.gzip > defaultChunkLimit.gzip);
    if (isChunk && !overDefault) continue;
    limits[key] = {
      raw: withHeadroom(actual.raw, headroom),
      gzip: withHeadroom(actual.gzip, headroom),
    };
  }
  return { defaultChunkLimit, limits };
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} kB`;
}

function percent(actual, limit) {
  return `${((actual / limit) * 100).toFixed(1)}%`;
}

/** Markdown report: budget lines first, then the largest assets. */
export function renderMarkdown({ assets, result, top = 15 }) {
  const lines = ["## Client bundle size", ""];
  lines.push(result.ok ? "Within budget." : "**Over budget.** See the rows marked `over`.", "");
  lines.push("| Budget line | Raw | Raw limit | Gzip | Gzip limit | Status |");
  lines.push("| --- | ---: | ---: | ---: | ---: | --- |");
  for (const row of result.rows) {
    if (!row.actual) {
      lines.push(`| \`${row.key}\` | - | ${formatBytes(row.limit.raw)} | - | ${formatBytes(row.limit.gzip)} | stale |`);
      continue;
    }
    const status =
      row.status === "over" ? `**over** (${row.over.join(", ")})${row.unlisted ? ", default limit" : ""}` : "ok";
    lines.push(
      `| \`${row.key}\` | ${formatBytes(row.actual.raw)} (${percent(row.actual.raw, row.limit.raw)}) | ${formatBytes(row.limit.raw)} | ${formatBytes(row.actual.gzip)} (${percent(row.actual.gzip, row.limit.gzip)}) | ${formatBytes(row.limit.gzip)} | ${status} |`,
    );
  }
  lines.push("", `### Largest assets (top ${Math.min(top, assets.length)} of ${assets.length})`, "");
  lines.push("| File | Raw | Gzip | Initial |");
  lines.push("| --- | ---: | ---: | :---: |");
  for (const asset of assets.slice(0, top)) {
    lines.push(
      `| \`${asset.file}\` | ${formatBytes(asset.raw)} | ${formatBytes(asset.gzip)} | ${asset.initial ? "yes" : ""} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Plain-text table of every asset for the job log. */
export function renderText(assets) {
  const width = Math.max(...assets.map((asset) => asset.file.length), 4);
  const rows = assets.map(
    (asset) =>
      `${asset.file.padEnd(width)}  ${formatBytes(asset.raw).padStart(10)}  ${formatBytes(asset.gzip).padStart(10)}${asset.initial ? "  initial" : ""}`,
  );
  return [`${"file".padEnd(width)}  ${"raw".padStart(10)}  ${"gzip".padStart(10)}`, ...rows].join("\n");
}
