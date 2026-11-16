import { describe, expect, it } from "vitest";
import {
  buildBaseline,
  compare,
  countByFileAndRule,
  isStrict,
  normalizePath,
  renderMarkdown,
  ruleId,
  toFindings,
  totalsByRule,
} from "../a11yRatchet.mjs";

const diagnostic = (filename, code, line = 1) => ({
  filename,
  code,
  message: `message for ${code}`,
  labels: [{ span: { line, column: 3 } }],
});

const STRICT = ["src/components/ui/"];
const LABEL = "jsx-a11y(label-has-associated-control)";
const ICON = "wired-a11y(icon-button-has-name)";

describe("normalising linter output", () => {
  it("turns plugin(rule) codes into plugin/rule ids", () => {
    expect(ruleId(LABEL)).toBe("jsx-a11y/label-has-associated-control");
    expect(ruleId(ICON)).toBe("wired-a11y/icon-button-has-name");
    expect(ruleId("no-debugger")).toBe("no-debugger");
  });

  it("normalises paths", () => {
    expect(normalizePath("./src/a.tsx")).toBe("src/a.tsx");
    expect(normalizePath("src\\features\\a.tsx")).toBe("src/features/a.tsx");
  });

  it("flattens diagnostics into findings", () => {
    expect(toFindings([diagnostic("src/a.tsx", LABEL, 12)])).toEqual([
      {
        file: "src/a.tsx",
        rule: "jsx-a11y/label-has-associated-control",
        line: 12,
        column: 3,
        message: `message for ${LABEL}`,
      },
    ]);
  });

  it("tolerates a diagnostic without a span", () => {
    expect(toFindings([{ filename: "src/a.tsx", code: LABEL, message: "m" }])[0]).toMatchObject({ line: 0 });
  });

  it("counts per file and rule with sorted keys", () => {
    const counts = countByFileAndRule(
      toFindings([diagnostic("src/b.tsx", LABEL), diagnostic("src/a.tsx", ICON), diagnostic("src/a.tsx", ICON)]),
    );
    expect(Object.keys(counts)).toEqual(["src/a.tsx", "src/b.tsx"]);
    expect(counts["src/a.tsx"]).toEqual({ "wired-a11y/icon-button-has-name": 2 });
  });
});

describe("strict paths", () => {
  it("matches by prefix", () => {
    expect(isStrict("src/components/ui/Modal.tsx", STRICT)).toBe(true);
    expect(isStrict("src/components/layout/Sidebar.tsx", STRICT)).toBe(false);
  });
});

describe("compare", () => {
  const baseline = {
    strict: STRICT,
    files: { "src/features/a.tsx": { "jsx-a11y/label-has-associated-control": 2 } },
  };

  it("passes when findings match the baseline exactly", () => {
    const findings = toFindings([diagnostic("src/features/a.tsx", LABEL), diagnostic("src/features/a.tsx", LABEL, 9)]);
    const result = compare(findings, baseline);
    expect(result).toMatchObject({ ok: true, strictViolations: [], regressions: [], improvements: [] });
  });

  it("fails on any violation in a strict path, baseline or not", () => {
    const findings = toFindings([diagnostic("src/components/ui/Modal.tsx", ICON, 4)]);
    const lenient = { strict: STRICT, files: { "src/components/ui/Modal.tsx": { "wired-a11y/icon-button-has-name": 5 } } };
    const result = compare(findings, lenient);
    expect(result.ok).toBe(false);
    expect(result.strictViolations).toHaveLength(1);
    expect(result.regressions).toEqual([]);
  });

  it("fails when a baselined file gains one more violation of the same rule", () => {
    const findings = toFindings([
      diagnostic("src/features/a.tsx", LABEL, 1),
      diagnostic("src/features/a.tsx", LABEL, 2),
      diagnostic("src/features/a.tsx", LABEL, 3),
    ]);
    const result = compare(findings, baseline);
    expect(result.ok).toBe(false);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toMatchObject({ file: "src/features/a.tsx", allowed: 2, found: 3 });
    expect(result.regressions[0].findings).toHaveLength(3);
  });

  it("fails on a new rule in a baselined file", () => {
    const findings = toFindings([
      diagnostic("src/features/a.tsx", LABEL),
      diagnostic("src/features/a.tsx", LABEL),
      diagnostic("src/features/a.tsx", ICON),
    ]);
    const result = compare(findings, baseline);
    expect(result.regressions).toEqual([
      expect.objectContaining({ rule: "wired-a11y/icon-button-has-name", allowed: 0, found: 1 }),
    ]);
  });

  it("fails on a violation in a file with no baseline entry", () => {
    const result = compare(toFindings([diagnostic("src/features/new.tsx", ICON)]), baseline);
    expect(result.ok).toBe(false);
    expect(result.regressions[0]).toMatchObject({ file: "src/features/new.tsx", allowed: 0, found: 1 });
  });

  it("does not let a fix in one file pay for a regression in another", () => {
    const twoFiles = {
      strict: STRICT,
      files: {
        "src/features/a.tsx": { "jsx-a11y/label-has-associated-control": 2 },
        "src/features/b.tsx": { "jsx-a11y/label-has-associated-control": 1 },
      },
    };
    // a.tsx fixed both, b.tsx gained one: totals went down, still a regression.
    const findings = toFindings([diagnostic("src/features/b.tsx", LABEL), diagnostic("src/features/b.tsx", LABEL, 2)]);
    const result = compare(findings, twoFiles);
    expect(result.ok).toBe(false);
    expect(result.regressions.map((r) => r.file)).toEqual(["src/features/b.tsx"]);
    expect(result.improvements).toEqual([
      { file: "src/features/a.tsx", rule: "jsx-a11y/label-has-associated-control", allowed: 2, found: 0 },
    ]);
  });

  it("reports slack as an improvement and still passes", () => {
    const result = compare(toFindings([diagnostic("src/features/a.tsx", LABEL)]), baseline);
    expect(result.ok).toBe(true);
    expect(result.improvements).toEqual([
      { file: "src/features/a.tsx", rule: "jsx-a11y/label-has-associated-control", allowed: 2, found: 1 },
    ]);
  });

  it("treats a missing baseline as empty", () => {
    expect(compare([], {}).ok).toBe(true);
    expect(compare(toFindings([diagnostic("src/x.tsx", ICON)]), {}).ok).toBe(false);
  });
});

describe("buildBaseline", () => {
  it("records non-strict findings only, so strict files can never be baselined", () => {
    const findings = toFindings([
      diagnostic("src/components/ui/Modal.tsx", ICON),
      diagnostic("src/features/a.tsx", LABEL),
      diagnostic("src/features/a.tsx", LABEL),
    ]);
    const baseline = buildBaseline(findings, STRICT);
    expect(baseline).toEqual({
      strict: STRICT,
      files: { "src/features/a.tsx": { "jsx-a11y/label-has-associated-control": 2 } },
    });
    // The strict violation still fails against the baseline just built.
    expect(compare(findings, baseline).ok).toBe(false);
  });
});

describe("reporting", () => {
  it("totals by rule", () => {
    expect(totalsByRule({ a: { r1: 2, r2: 1 }, b: { r1: 3 } })).toEqual({ r1: 5, r2: 1 });
  });

  it("renders baseline vs current per rule and mentions slack", () => {
    const baseline = { strict: STRICT, files: { "src/features/a.tsx": { "jsx-a11y/label-has-associated-control": 2 } } };
    const findings = toFindings([diagnostic("src/features/a.tsx", LABEL)]);
    const md = renderMarkdown({ findings, baseline, result: compare(findings, baseline) });
    expect(md).toContain("No new violations.");
    expect(md).toContain("| `jsx-a11y/label-has-associated-control` | 2 | 1 |");
    expect(md).toContain("| **Total** | **2** | **1** |");
    expect(md).toContain("1 baseline entry has slack");
  });

  it("renders the failure headline", () => {
    const findings = toFindings([diagnostic("src/components/ui/Modal.tsx", ICON), diagnostic("src/features/n.tsx", ICON)]);
    const baseline = { strict: STRICT, files: {} };
    const md = renderMarkdown({ findings, baseline, result: compare(findings, baseline) });
    expect(md).toContain("**1 violation(s) in strict paths, 1 regression(s) against the baseline.**");
  });
});
