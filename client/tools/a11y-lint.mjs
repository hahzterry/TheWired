#!/usr/bin/env node
/**
 * Accessibility lint for client/src: oxlint's jsx-a11y rules plus the local
 * rules in oxlint-plugin-wired-a11y.mjs (config: .oxlintrc.json), filtered
 * through the ratchet in a11yRatchet.mjs against a11y-lint-baseline.json.
 *
 *   node tools/a11y-lint.mjs            fail on strict-path violations and on
 *                                       anything above the baseline
 *   node tools/a11y-lint.mjs --update   rewrite the baseline from the current
 *                                       findings (strict paths never get one)
 *   node tools/a11y-lint.mjs --all      also print every baselined finding
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBaseline, compare, renderMarkdown, toFindings } from "./a11yRatchet.mjs";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(clientDir, ".oxlintrc.json");
const baselinePath = path.join(clientDir, "a11y-lint-baseline.json");
const args = new Set(process.argv.slice(2));

const require = createRequire(import.meta.url);
const oxlintBin = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin", "oxlint");

const run = spawnSync(process.execPath, [oxlintBin, "-c", configPath, "-f", "json", "src"], {
  cwd: clientDir,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error("oxlint did not produce a JSON report.");
  console.error(run.stderr || run.stdout);
  process.exit(2);
}

// A config or plugin that fails to load must not look like a clean run.
const config = JSON.parse(readFileSync(configPath, "utf8"));
const expectedRules = Object.values(config.rules).filter((level) => level !== "off").length;
if (report.number_of_rules !== expectedRules || !report.number_of_files) {
  console.error(
    `oxlint ran ${report.number_of_rules} rule(s) over ${report.number_of_files} file(s); expected ${expectedRules} rule(s). Check .oxlintrc.json and the local plugin.`,
  );
  process.exit(2);
}

const findings = toFindings(report.diagnostics);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

if (args.has("--update")) {
  const next = buildBaseline(findings, baseline.strict);
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  const total = findings.length - compare(findings, next).strictViolations.length;
  console.log(`Baseline rewritten: ${total} violation(s) across ${Object.keys(next.files).length} file(s).`);
}

const result = compare(findings, JSON.parse(readFileSync(baselinePath, "utf8")));
const annotate = (finding, title) =>
  process.env.GITHUB_ACTIONS
    ? `::error file=client/${finding.file},line=${finding.line},col=${finding.column},title=${title}::${finding.rule}: ${finding.message}`
    : `  ${finding.file}:${finding.line}:${finding.column}  ${finding.rule}  ${finding.message}`;

if (args.has("--all")) {
  for (const finding of findings) console.log(annotate(finding, "a11y"));
}

if (result.strictViolations.length) {
  console.error(`\n${result.strictViolations.length} violation(s) in strict paths (${baseline.strict.join(", ")}):`);
  for (const finding of result.strictViolations) console.error(annotate(finding, "a11y (strict path)"));
}
for (const regression of result.regressions) {
  console.error(
    `\n${regression.file}: ${regression.rule} has ${regression.found} violation(s), baseline allows ${regression.allowed}:`,
  );
  for (const finding of regression.findings) console.error(annotate(finding, "a11y (above baseline)"));
}
if (result.improvements.length) {
  const fixed = result.improvements.reduce((sum, item) => sum + item.allowed - item.found, 0);
  const note = `${fixed} baselined violation(s) no longer occur. Run \`pnpm --filter @thewired/client lint:a11y --update\` to tighten the baseline.`;
  console.log(process.env.GITHUB_ACTIONS ? `::notice title=a11y baseline has slack::${note}` : `\nnote: ${note}`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown({ findings, baseline, result }));
}

const baselined = findings.length - result.strictViolations.length;
if (!result.ok) {
  console.error(
    "\nAccessibility lint failed. Fix the violations above; the baseline only covers what already existed (docs/A11Y_BASELINE.md).",
  );
  process.exit(1);
}
console.log(
  `\nAccessibility lint passed: ${report.number_of_files} files, ${expectedRules} rules, 0 new violations (${baselined} baselined).`,
);
