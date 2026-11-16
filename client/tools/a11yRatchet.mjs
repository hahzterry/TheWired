/**
 * Ratchet for the accessibility lint. The linter reports every violation in
 * client/src; this decides which of them fail the run:
 *
 *   - a violation in a strict path (the shared primitives) always fails;
 *   - anywhere else, a (file, rule) pair fails only when it has MORE
 *     violations than the committed baseline allows.
 *
 * The baseline stores counts, not line numbers, so unrelated edits that move
 * code around do not invalidate it. Fixing violations leaves slack in the
 * baseline; that is reported (not failed) so the baseline can be tightened
 * with `--update`.
 */

/** `jsx-a11y(alt-text)` -> `jsx-a11y/alt-text`. */
export function ruleId(code) {
  const match = /^(.+)\((.+)\)$/.exec(code ?? "");
  return match ? `${match[1]}/${match[2]}` : String(code);
}

export function normalizePath(filename) {
  return filename.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Flatten linter JSON into `{ file, rule, line, column, message }` records. */
export function toFindings(diagnostics) {
  return diagnostics.map((diagnostic) => {
    const span = diagnostic.labels?.[0]?.span;
    return {
      file: normalizePath(diagnostic.filename),
      rule: ruleId(diagnostic.code),
      line: span?.line ?? 0,
      column: span?.column ?? 0,
      message: diagnostic.message,
    };
  });
}

export function isStrict(file, strictPaths) {
  return strictPaths.some((prefix) => file.startsWith(prefix));
}

/** `{ [file]: { [rule]: count } }`, keys sorted so the JSON diff is stable. */
export function countByFileAndRule(findings) {
  const counts = {};
  for (const { file, rule } of findings) {
    counts[file] ??= {};
    counts[file][rule] = (counts[file][rule] ?? 0) + 1;
  }
  return sortKeys(counts);
}

function sortKeys(counts) {
  const sorted = {};
  for (const file of Object.keys(counts).sort()) {
    sorted[file] = {};
    for (const rule of Object.keys(counts[file]).sort()) sorted[file][rule] = counts[file][rule];
  }
  return sorted;
}

/**
 * @param findings   output of toFindings()
 * @param baseline   { strict: string[], files: { [file]: { [rule]: count } } }
 * @returns {
 *   strictViolations: finding[]                     always fail
 *   regressions: { file, rule, allowed, found, findings }[]   fail
 *   improvements: { file, rule, allowed, found }[]  slack, informational
 *   ok: boolean
 * }
 */
export function compare(findings, baseline) {
  const strictPaths = baseline.strict ?? [];
  const allowed = baseline.files ?? {};

  const strictViolations = findings.filter((finding) => isStrict(finding.file, strictPaths));
  const rest = findings.filter((finding) => !isStrict(finding.file, strictPaths));
  const current = countByFileAndRule(rest);

  const regressions = [];
  for (const [file, rules] of Object.entries(current)) {
    for (const [rule, found] of Object.entries(rules)) {
      const limit = allowed[file]?.[rule] ?? 0;
      if (found > limit) {
        regressions.push({
          file,
          rule,
          allowed: limit,
          found,
          findings: rest.filter((finding) => finding.file === file && finding.rule === rule),
        });
      }
    }
  }

  const improvements = [];
  for (const [file, rules] of Object.entries(allowed)) {
    for (const [rule, limit] of Object.entries(rules)) {
      const found = current[file]?.[rule] ?? 0;
      if (found < limit) improvements.push({ file, rule, allowed: limit, found });
    }
  }

  return {
    strictViolations,
    regressions,
    improvements,
    ok: strictViolations.length === 0 && regressions.length === 0,
  };
}

/** The baseline to commit for the current findings (strict files never get one). */
export function buildBaseline(findings, strictPaths) {
  const rest = findings.filter((finding) => !isStrict(finding.file, strictPaths));
  return { strict: strictPaths, files: countByFileAndRule(rest) };
}

/** `{ [rule]: total }` across a `{ [file]: { [rule]: count } }` map. */
export function totalsByRule(files) {
  const totals = {};
  for (const rules of Object.values(files)) {
    for (const [rule, count] of Object.entries(rules)) totals[rule] = (totals[rule] ?? 0) + count;
  }
  return totals;
}

export function renderMarkdown({ findings, baseline, result }) {
  const strictPaths = baseline.strict ?? [];
  const current = totalsByRule(
    countByFileAndRule(findings.filter((finding) => !isStrict(finding.file, strictPaths))),
  );
  const allowed = totalsByRule(baseline.files ?? {});
  const rules = [...new Set([...Object.keys(current), ...Object.keys(allowed)])].sort();

  const lines = ["## Accessibility lint", ""];
  lines.push(
    result.ok
      ? "No new violations."
      : `**${result.strictViolations.length} violation(s) in strict paths, ${result.regressions.length} regression(s) against the baseline.**`,
    "",
  );
  lines.push(`Strict paths (zero tolerance): ${strictPaths.map((p) => `\`${p}\``).join(", ")}`, "");
  lines.push("| Rule | Baseline | Now |", "| --- | ---: | ---: |");
  for (const rule of rules) lines.push(`| \`${rule}\` | ${allowed[rule] ?? 0} | ${current[rule] ?? 0} |`);
  const sum = (totals) => Object.values(totals).reduce((a, b) => a + b, 0);
  lines.push(`| **Total** | **${sum(allowed)}** | **${sum(current)}** |`);
  if (result.improvements.length) {
    lines.push(
      "",
      `${result.improvements.length} baseline entr${result.improvements.length === 1 ? "y has" : "ies have"} slack. Run \`pnpm --filter @thewired/client lint:a11y --update\` to tighten.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
