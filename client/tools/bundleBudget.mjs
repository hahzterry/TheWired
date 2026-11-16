/**
 * Bundle-size accounting for the client production build. Pure functions plus
 * one directory reader, so the CLI (bundle-size.mjs) stays a thin shell and
 * the logic is unit-testable without running a build.
 *
 * Budget lines are keyed on things that survive unrelated changes:
 *
 *   initial:js      the JS fetched before first paint: the entry script in
 *                   index.html plus every <link rel="modulepreload">. Read
 *                   from index.html, so it does not depend on chunk names.
 *   total:js/css    everything emitted.
 *   chunk:<name>    a chunk whose name we choose: the file name of a module
 *                   passed to import() (`import("./livekitClient")` is always
 *                   `livekitClient-<hash>.js`). Only for the deliberately
 *                   large lazy chunks.
 *   otherChunkLimit a ceiling for every other lazy chunk, per file. Shared
 *                   chunks are named after whichever module the bundler
 *                   picked, and an unrelated import change renames them, so
 *                   they get a ceiling instead of a line each.
 *
 * A line that matches nothing in the build is an error: the thing it guarded
 * was renamed or removed, and the budget has to say so.
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

const METRICS = ["raw", "gzip"];

function overMetrics(actual, limit) {
  return METRICS.filter((metric) => actual[metric] > limit[metric]);
}

/**
 * Compare a build with a budget.
 *
 * budget = {
 *   limits: { "<key>": { raw, gzip } },   initial:js, total:*, chunk:<name>
 *   otherChunkLimit: { raw, gzip },       per-file ceiling for lazy chunks
 *                                         that have no chunk:<name> line
 * }
 *
 * Row statuses: `ok`, `over`, and `missing` for a line that matches nothing
 * in the build. `over` and `missing` both fail.
 */
export function checkBudget(assets, budget) {
  const measurements = measure(assets);
  const limits = budget.limits ?? {};
  const rows = [];

  for (const [key, limit] of Object.entries(limits)) {
    const actual = measurements[key];
    if (!actual || actual.files === 0) {
      rows.push({ key, limit, actual: null, status: "missing", over: [] });
      continue;
    }
    const over = overMetrics(actual, limit);
    rows.push({ key, limit, actual, status: over.length ? "over" : "ok", over });
  }

  const ceiling = budget.otherChunkLimit;
  if (ceiling) {
    const others = otherLazyChunks(assets, limits);
    const largest = {
      raw: Math.max(0, ...others.map((asset) => asset.raw)),
      gzip: Math.max(0, ...others.map((asset) => asset.gzip)),
      files: others.length,
    };
    const offenders = others.filter((asset) => overMetrics(asset, ceiling).length > 0);
    const over = METRICS.filter((metric) => largest[metric] > ceiling[metric]);
    rows.push({
      key: "otherChunkLimit",
      limit: ceiling,
      actual: largest,
      status: over.length ? "over" : "ok",
      over,
      offenders: offenders.map((asset) => asset.file),
    });
  }

  return { rows, ok: rows.every((row) => row.status === "ok") };
}

/** Lazy JS files that no `chunk:<name>` line covers. */
export function otherLazyChunks(assets, limits) {
  return assets.filter(
    (asset) => asset.type === "js" && !asset.initial && !(`chunk:${asset.name}` in limits),
  );
}

/** Round up to the next multiple of `step` after adding `headroom` (0.03 = 3%). */
export function withHeadroom(bytes, headroom, step = 1024) {
  return Math.ceil((bytes * (1 + headroom)) / step) * step;
}

/** Headroom per kind of line. The startup payload is held tightest. */
export const HEADROOM = { initial: 0.02, line: 0.03, otherChunk: 0.05 };

/**
 * Re-record the existing lines from the current build. The set of lines does
 * not change: adding or removing one is a decision, made by editing the file.
 * Throws when a line matches nothing, because there is nothing to record.
 */
export function rerecordBudget(assets, budget) {
  const measurements = measure(assets);
  const limits = {};
  for (const key of Object.keys(budget.limits ?? {})) {
    const actual = measurements[key];
    if (!actual || actual.files === 0) {
      throw new Error(`budget line "${key}" matches nothing in this build; remove or rename it first`);
    }
    const headroom = key === "initial:js" ? HEADROOM.initial : HEADROOM.line;
    limits[key] = { raw: withHeadroom(actual.raw, headroom), gzip: withHeadroom(actual.gzip, headroom) };
  }
  const next = { limits };
  if (budget.otherChunkLimit) {
    const others = otherLazyChunks(assets, limits);
    next.otherChunkLimit = {
      raw: withHeadroom(Math.max(0, ...others.map((asset) => asset.raw)), HEADROOM.otherChunk),
      gzip: withHeadroom(Math.max(0, ...others.map((asset) => asset.gzip)), HEADROOM.otherChunk),
    };
  }
  return next;
}

/** Decimal units (1 kB = 1000 B), the same as Vite's build output. */
export function formatBytes(bytes) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
  return `${(bytes / 1000).toFixed(1)} kB`;
}

function percent(actual, limit) {
  return `${((actual / limit) * 100).toFixed(1)}%`;
}

/** Markdown report: budget lines first, then the largest assets. */
export function renderMarkdown({ assets, result, top = 15 }) {
  const lines = ["## Client bundle size", ""];
  lines.push(result.ok ? "Within budget." : "**Budget check failed.** See the rows marked `over` or `missing`.", "");
  lines.push("| Budget line | Raw | Raw limit | Gzip | Gzip limit | Status |");
  lines.push("| --- | ---: | ---: | ---: | ---: | --- |");
  for (const row of result.rows) {
    if (!row.actual) {
      lines.push(
        `| \`${row.key}\` | - | ${formatBytes(row.limit.raw)} | - | ${formatBytes(row.limit.gzip)} | **missing**: nothing in the build matches |`,
      );
      continue;
    }
    const label = row.key === "otherChunkLimit" ? "largest other lazy chunk" : `\`${row.key}\``;
    const status =
      row.status === "over"
        ? `**over** (${row.over.join(", ")})${row.offenders?.length ? `: ${row.offenders.map((f) => `\`${f}\``).join(", ")}` : ""}`
        : "ok";
    lines.push(
      `| ${label} | ${formatBytes(row.actual.raw)} (${percent(row.actual.raw, row.limit.raw)}) | ${formatBytes(row.limit.raw)} | ${formatBytes(row.actual.gzip)} (${percent(row.actual.gzip, row.limit.gzip)}) | ${formatBytes(row.limit.gzip)} | ${status} |`,
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
