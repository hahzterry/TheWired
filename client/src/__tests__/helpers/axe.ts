import axe from "axe-core";
import { expect } from "vitest";

/**
 * Run axe-core against rendered markup and fail on any violation.
 *
 * jsdom has no layout or paint, so rules that need them are off:
 * `color-contrast` (no computed colours) and `region` (page-level landmark
 * rule that does not apply to a component rendered on its own).
 */
export async function expectNoAxeViolations(
  root: Element = document.body,
  options: { disable?: string[] } = {},
): Promise<void> {
  const disabled = ["color-contrast", "region", ...(options.disable ?? [])];
  const results = await axe.run(root, {
    rules: Object.fromEntries(disabled.map((id) => [id, { enabled: false }])),
  });
  const summary = results.violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => node.html),
  }));
  expect(summary).toEqual([]);
}

/** The rule ids axe reports for `root` (for asserting that a check can fail). */
export async function axeViolationIds(root: Element = document.body): Promise<string[]> {
  const results = await axe.run(root, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return results.violations.map((violation) => violation.id);
}
