// @vitest-environment node
/**
 * Runs the real linter (same config as `pnpm lint:a11y`) over small fixtures,
 * so the local rule is tested the way it is used, and a linter upgrade that
 * breaks plugin loading fails here.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const oxlintBin = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin", "oxlint");

// Fixtures go in the OS temp dir: outside the repo's .gitignore and the
// config's ignorePatterns, both of which the linter honours.
const fixtureDir = mkdtempSync(path.join(tmpdir(), "wired-lint-fixtures-"));
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

let counter = 0;
function lint(source) {
  const dir = path.join(fixtureDir, `case-${counter++}`);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "Fixture.tsx"), source);
  const run = spawnSync(
    process.execPath,
    [oxlintBin, "-c", path.join(clientDir, ".oxlintrc.json"), "--no-ignore", "-f", "json", dir],
    { cwd: clientDir, encoding: "utf8" },
  );
  const report = JSON.parse(run.stdout);
  return report.diagnostics.map((d) => d.code);
}

const ICON_RULE = "wired-a11y(icon-button-has-name)";
const withIcons = (jsx) =>
  `import { X, Eye, EyeOff } from "lucide-react";\nexport function Fixture(props: { on: boolean; rest: object }) {\n  return (${jsx});\n}\n`;

describe("wired-a11y/icon-button-has-name", () => {
  it("flags a button whose only content is a lucide icon", () => {
    expect(lint(withIcons(`<button onClick={() => {}}><X size={12} /></button>`))).toEqual([ICON_RULE]);
  });

  it("leaves an inline <svg> button to the stock rule (no double report)", () => {
    expect(lint(withIcons(`<button><svg viewBox="0 0 1 1"><path d="" /></svg></button>`))).toEqual([
      "jsx-a11y(control-has-associated-label)",
    ]);
  });

  it("flags icon-only content behind a conditional or &&", () => {
    expect(lint(withIcons(`<button>{props.on ? <Eye /> : <EyeOff />}</button>`))).toEqual([ICON_RULE]);
    expect(lint(withIcons(`<button>{props.on && <Eye />}</button>`))).toEqual([ICON_RULE]);
  });

  it('flags role="button" elements too', () => {
    expect(lint(withIcons(`<span role="button" tabIndex={0} onKeyDown={() => {}} onClick={() => {}}><X /></span>`))).toContain(ICON_RULE);
  });

  it.each([
    ["aria-label", `<button aria-label="Close"><X /></button>`],
    ["aria-labelledby", `<button aria-labelledby="t"><X /></button>`],
    ["title", `<button title="Close"><X /></button>`],
  ])("accepts %s as the name", (_name, jsx) => {
    expect(lint(withIcons(jsx))).toEqual([]);
  });

  it("accepts visible text next to the icon", () => {
    expect(lint(withIcons(`<button><X /> Close</button>`))).toEqual([]);
    expect(lint(withIcons(`<button><X /><span>Close</span></button>`))).toEqual([]);
  });

  it("skips buttons with a spread (the name may come through it)", () => {
    expect(lint(withIcons(`<button {...props.rest}><X /></button>`))).toEqual([]);
  });

  it("does not treat an unknown component as an icon", () => {
    const source = `import { Label } from "./Label";\nexport const Fixture = () => <button><Label /></button>;\n`;
    expect(lint(source)).toEqual([]);
  });

  it("ignores non-button elements", () => {
    expect(lint(withIcons(`<div><X /></div>`))).toEqual([]);
  });
});

describe("stock jsx-a11y rules are active in the same config", () => {
  it("flags a label that is not tied to a control", () => {
    const source = `export const Fixture = () => (<div><label>Name</label><input type="text" /></div>);\n`;
    expect(lint(source)).toEqual(["jsx-a11y(label-has-associated-control)"]);
  });

  it("flags a click handler on a static element", () => {
    const source = `export const Fixture = () => <div onClick={() => {}}>x</div>;\n`;
    expect(lint(source).sort()).toEqual([
      "jsx-a11y(click-events-have-key-events)",
      "jsx-a11y(no-static-element-interactions)",
    ]);
  });
});
