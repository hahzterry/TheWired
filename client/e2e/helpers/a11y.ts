import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect } from "@playwright/test";

/**
 * axe scans with a ratchet, mirroring the lint baseline:
 *
 *   e2e/a11y-baseline.json   { "<screen>": { "<axe rule id>": <node count> } }
 *
 * A scan fails when a screen shows a rule that is not in its baseline, or more
 * failing nodes for a rule than the baseline allows. Fewer is fine (and worth
 * tightening). Regenerate with UPDATE_A11Y_BASELINE=1 after fixing things.
 *
 * The baseline exists because most of the app's screens are outside the shared
 * primitives; what it currently allows is itemised in docs/A11Y_BASELINE.md.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(here, "..", "a11y-baseline.json");
const UPDATE = !!process.env.UPDATE_A11Y_BASELINE;

/**
 * Rules whose node count follows how much content happens to be on screen
 * (every muted label fails contrast; every block outside a landmark fails
 * `region`). Their count is not a useful ratchet, so the baseline records
 * them as "any": allowed while listed, strict again once the entry is removed.
 */
const VOLUME_RULES = new Set(["color-contrast", "region"]);

type Allowance = number | "any";
type Baseline = Record<string, Record<string, Allowance>>;

function readBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

export interface ScanResult {
  /** rule id → number of failing nodes */
  counts: Record<string, number>;
  /** rule id → the failing nodes' selectors, for the failure message */
  nodes: Record<string, string[]>;
}

/** Run axe (WCAG 2.x A/AA + best-practice rules) on the page or one region of it. */
export async function scan(page: Page, options: { include?: string; rules?: string[] } = {}): Promise<ScanResult> {
  let builder = new AxeBuilder({ page });
  if (options.rules) builder = builder.withRules(options.rules);
  else builder = builder.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]);
  if (options.include) builder = builder.include(options.include);
  const results = await builder.analyze();

  const counts: Record<string, number> = {};
  const nodes: Record<string, string[]> = {};
  for (const violation of results.violations) {
    counts[violation.id] = violation.nodes.length;
    nodes[violation.id] = violation.nodes.map((node) => node.target.join(" "));
  }
  return { counts, nodes };
}

/** What a scan found beyond the baseline: `rule: found N, allowed M` lines. */
export function compareWithBaseline(
  counts: Record<string, number>,
  allowed: Record<string, Allowance> = {},
): string[] {
  const problems: string[] = [];
  for (const [rule, found] of Object.entries(counts)) {
    const limit = allowed[rule] ?? 0;
    if (limit === "any") continue;
    if (found > limit) problems.push(`${rule}: found ${found}, baseline allows ${limit}`);
  }
  return problems;
}

/**
 * Scan and hold the result to the baseline entry for `screen`.
 * With UPDATE_A11Y_BASELINE=1 the entry is rewritten instead.
 */
export async function expectNoNewViolations(page: Page, screen: string, options: { include?: string } = {}) {
  const result = await scan(page, options);

  if (UPDATE) {
    const baseline = readBaseline();
    baseline[screen] = Object.fromEntries(
      Object.entries(result.counts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([rule, count]): [string, Allowance] => [rule, VOLUME_RULES.has(rule) ? "any" : count]),
    );
    const sorted = Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
    return result;
  }

  const problems = compareWithBaseline(result.counts, readBaseline()[screen]);
  const detail = problems
    .map((line) => {
      const rule = line.split(":")[0];
      return `${line}\n${result.nodes[rule].map((target) => `    ${target}`).join("\n")}`;
    })
    .join("\n");
  expect(problems, `new accessibility violations on "${screen}":\n${detail}`).toEqual([]);
  return result;
}

/**
 * Cut the page off from everything but the dev server, so every run (CI with
 * no backend, a laptop with the full stack up) renders the same empty-state
 * screens and the baseline counts are stable. WebSockets other than Vite's are
 * accepted and left silent: a refused socket would start reconnect loops.
 */
export async function isolateFromNetwork(page: Page) {
  const isApp = (url: URL) => url.hostname === "localhost" && url.port === (process.env.WIRED_PORT ?? "1420");
  await page.route(
    (url) => !isApp(url) && url.protocol.startsWith("http"),
    (route) => route.abort("connectionrefused"),
  );
  await page.routeWebSocket(
    (url) => !isApp(url),
    () => {
      /* accept and stay silent */
    },
  );
}

/**
 * Log in with a fresh identity and wait for a settled shell. A new account
 * always gets the first-run profile wizard about a second after login, so
 * this waits for it and skips it, instead of racing it: a scan taken with
 * the wizard half-open would not match the baseline.
 */
export async function enterShell(page: Page) {
  await page.goto("/");
  const generate = page.getByRole("button", { name: /generate new identity/i });
  await expect(generate).toBeVisible({ timeout: 20_000 });
  await generate.click();

  // Generic <Modal>s share the overlay classes; only the wizard lacks the fade-in class.
  const wizard = page.locator("div.fixed.inset-0.z-50:not(.animate-fade-in-up)").first();
  await wizard.waitFor({ state: "visible", timeout: 30_000 });
  await wizard.locator("button:has(svg.lucide-x)").first().click();
  await page.getByRole("button", { name: /^skip$/i }).click();
  await wizard.waitFor({ state: "hidden", timeout: 10_000 });

  await expect(page.getByRole("button", { name: "New Space" })).toBeVisible({ timeout: 20_000 });
}

/** Client-side navigation: a full reload would drop the in-memory session. */
export async function navigateInApp(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}
