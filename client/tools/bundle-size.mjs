#!/usr/bin/env node
/**
 * Report the size of the client production build and check it against
 * bundle-budget.json. Run after `pnpm build`.
 *
 *   node tools/bundle-size.mjs            report + check (exit 1 when a line is
 *                                         over, or matches nothing)
 *   node tools/bundle-size.mjs --update   re-record the existing lines from
 *                                         this build (lines are added or
 *                                         removed by editing the file)
 *
 * In GitHub Actions the report is also appended to the job summary.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkBudget, collectAssets, renderMarkdown, renderText, rerecordBudget } from "./bundleBudget.mjs";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(clientDir, "dist");
const budgetPath = path.join(clientDir, "bundle-budget.json");
const update = process.argv.includes("--update");

if (!existsSync(path.join(distDir, "index.html"))) {
  console.error("No build output at client/dist. Run `pnpm build` first.");
  process.exit(2);
}

const assets = collectAssets(distDir);
const budget = JSON.parse(readFileSync(budgetPath, "utf8"));

if (update) {
  let next;
  try {
    next = rerecordBudget(assets, budget);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
  writeFileSync(budgetPath, `${JSON.stringify({ ...budget, ...next }, null, 2)}\n`);
  console.log(`Re-recorded ${path.relative(process.cwd(), budgetPath)} from the current build.`);
  process.exit(0);
}

const result = checkBudget(assets, budget);
console.log(renderText(assets));
console.log("");
for (const row of result.rows) {
  if (!row.actual) {
    console.log(`missing  ${row.key}: nothing in the build matches this line`);
    continue;
  }
  console.log(
    `${row.status.padEnd(7)}  ${row.key}: raw ${row.actual.raw} / ${row.limit.raw}, gzip ${row.actual.gzip} / ${row.limit.gzip}`,
  );
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown({ assets, result }));
}

if (!result.ok) {
  const report = (message) =>
    console.error(process.env.GITHUB_ACTIONS ? `::error title=Bundle budget::${message}` : `error: ${message}`);
  for (const row of result.rows) {
    if (row.status === "missing") {
      report(`${row.key} matches nothing in the build. The chunk was renamed or removed: update the line.`);
    } else if (row.status === "over" && row.key === "otherChunkLimit") {
      report(`lazy chunk over the ${row.over.join(" and ")} ceiling for unlisted chunks: ${row.offenders.join(", ")}`);
    } else if (row.status === "over") {
      report(`${row.key} is over its ${row.over.join(" and ")} budget`);
    }
  }
  console.error(
    "\nThe build does not fit client/bundle-budget.json. Split or trim the code, or, if the change is intended, edit the budget in the same change.",
  );
  process.exit(1);
}
console.log("\nBundle is within budget.");
