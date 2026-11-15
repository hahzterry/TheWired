#!/usr/bin/env node
/**
 * Report the size of the client production build and check it against
 * bundle-budget.json. Run after `pnpm build`.
 *
 *   node tools/bundle-size.mjs            report + check (exit 1 when over)
 *   node tools/bundle-size.mjs --update   rewrite the budget from this build
 *
 * In GitHub Actions the report is also appended to the job summary.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkBudget,
  collectAssets,
  measure,
  proposeBudget,
  renderMarkdown,
  renderText,
} from "./bundleBudget.mjs";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(clientDir, "dist");
const budgetPath = path.join(clientDir, "bundle-budget.json");
const update = process.argv.includes("--update");

if (!existsSync(path.join(distDir, "index.html"))) {
  console.error("No build output at client/dist. Run `pnpm build` first.");
  process.exit(2);
}

const assets = collectAssets(distDir);
const measurements = measure(assets);
const budget = JSON.parse(readFileSync(budgetPath, "utf8"));

if (update) {
  const next = proposeBudget(measurements, { defaultChunkLimit: budget.defaultChunkLimit });
  writeFileSync(budgetPath, `${JSON.stringify({ ...budget, ...next }, null, 2)}\n`);
  console.log(`Rewrote ${path.relative(process.cwd(), budgetPath)} from the current build.`);
  process.exit(0);
}

const result = checkBudget(measurements, budget);
console.log(renderText(assets));
console.log("");
for (const row of result.rows) {
  if (!row.actual) {
    console.log(`stale  ${row.key}: nothing in the build matches this line; remove it`);
    continue;
  }
  console.log(
    `${row.status.padEnd(5)}  ${row.key}: raw ${row.actual.raw} / ${row.limit.raw}, gzip ${row.actual.gzip} / ${row.limit.gzip}`,
  );
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown({ assets, result }));
}

if (!result.ok) {
  for (const row of result.rows.filter((r) => r.status === "over")) {
    const message = `${row.key} is over its ${row.over.join(" and ")} budget${row.unlisted ? " (default chunk limit)" : ""}`;
    console.error(process.env.GITHUB_ACTIONS ? `::error title=Bundle budget::${message}` : `error: ${message}`);
  }
  console.error(
    "\nThe bundle grew past client/bundle-budget.json. Split or trim the code, or, if the growth is intended, raise the line in the budget file in the same change.",
  );
  process.exit(1);
}
console.log("\nBundle is within budget.");
