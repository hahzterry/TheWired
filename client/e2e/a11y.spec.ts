/**
 * Accessibility checks in a real browser.
 *
 * Part 1 drives every shared primitive (src/components/ui) on the harness page
 * with the keyboard and holds it to zero axe violations. jsdom cannot check
 * what matters most here: real focus order, `inert`, :focus-visible, and which
 * element a pointer press lands on.
 *
 * Part 2 scans the app shell and a few core screens. Those are mostly outside
 * the primitives, so they are held to a committed baseline (a11y-baseline.json,
 * itemised in docs/A11Y_BASELINE.md): existing findings pass, new ones fail.
 *
 * Both parts run with the page cut off from relays and the API, so they need
 * nothing but the Vite dev server and render the same thing everywhere.
 */
import { test, expect, type Page } from "@playwright/test";
import { installTauriMock } from "./support/tauriKeystoreMock";
import {
  compareWithBaseline,
  enterShell,
  expectNoNewViolations,
  isolateFromNetwork,
  navigateInApp,
  scan,
} from "./helpers/a11y";

const HARNESS = "/e2e/harness/primitives.html";

/**
 * Zero tolerance on the harness, with two exceptions that are not the
 * primitives' markup:
 *  - `color-contrast`: the theme's muted-text and primary-button colours are
 *    below 4.5:1. Changing tokens is a design decision (see the baseline doc).
 *  - `region`: menus and popovers are portaled to <body>, outside any
 *    landmark. That is how a portal works; dialogs are exempt from the rule
 *    for the same reason.
 */
async function expectClean(page: Page, include?: string) {
  const { counts, nodes } = await scan(page, { include });
  delete counts["color-contrast"];
  delete counts.region;
  expect(counts, JSON.stringify(nodes, null, 2)).toEqual({});
}

async function focused(page: Page) {
  // Let focus-driven transitions (a control that fades in on focus) finish.
  await page.waitForTimeout(200);
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { name: "<body>", inert: false, visible: true };
    let visible = true;
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.opacity === "0" || style.visibility === "hidden") visible = false;
    }
    return {
      name: el.getAttribute("aria-label") || (el.textContent ?? "").trim().replace(/\s+/g, " ") || el.tagName,
      inert: !!el.closest("[inert]"),
      visible,
    };
  });
}

test.describe("primitives (harness, zero tolerance)", () => {
  test.beforeEach(async ({ page }) => {
    await isolateFromNetwork(page);
    await page.goto(HARNESS);
    await expect(page.getByRole("heading", { name: "UI primitives" })).toBeVisible({ timeout: 20_000 });
  });

  test("idle page has no axe violations", async ({ page }) => {
    await expectClean(page);
  });

  test("Tab reaches every control, and nothing invisible or inert", async ({ page }) => {
    const stops: Awaited<ReturnType<typeof focused>>[] = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const stop = await focused(page);
      stops.push(stop);
      if (stop.name === "Last control") break;
    }
    const names = stops.map((stop) => stop.name);
    expect(names.at(-1)).toBe("Last control");
    // Closed menus stay mounted (they fade out) but must not be tab stops.
    expect(names).not.toContain("Copy text");
    expect(stops.filter((stop) => stop.inert || !stop.visible)).toEqual([]);
    // The upload drop zone is a real control now.
    expect(names).toContain("Upload image or paste URL");
    expect(names).toContain("Remove image");
    expect(names).toContain("Read receipts");
  });

  test("Modal: named, traps Tab, closes on Escape and on a backdrop press, returns focus", async ({ page }) => {
    const opener = page.getByRole("button", { name: "Open modal" });
    await opener.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Rename space" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    await expect(name).toBeFocused();
    await expectClean(page, '[role="dialog"]');

    // Tab cycles inside: Name → Delete… → Save → Name.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Delete…" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Save" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(name).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Save" })).toBeFocused();

    // A press inside the panel keeps it open; a press on the backdrop closes it.
    await page.getByTestId("modal-panel").click({ position: { x: 5, y: 5 } });
    await expect(dialog).toBeVisible();
    await page.mouse.click(8, 8);
    await expect(dialog).toBeHidden();

    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("ConfirmDialog over a Modal: one alertdialog, Escape peels one layer at a time", async ({ page }) => {
    await page.getByRole("button", { name: "Open modal" }).click();
    await page.getByRole("button", { name: "Delete…" }).click();

    const confirm = page.getByRole("alertdialog", { name: "Delete space?" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toHaveAccessibleDescription("This cannot be undone.");
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expectClean(page, '[role="alertdialog"]');

    await page.keyboard.press("Escape");
    await expect(confirm).toBeHidden();
    await expect(page.getByRole("dialog", { name: "Rename space" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete…" })).toBeFocused();

    // Confirm with the keyboard: Tab to Delete, Enter.
    await page.keyboard.press("Enter");
    await expect(confirm).toBeVisible();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(confirm).toBeHidden();
    await expect(page.getByTestId("deleted-count")).toHaveText("deleted: 1");

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  for (const kind of ["Inline", "Portal"] as const) {
    test(`PopoverMenu (${kind.toLowerCase()}): menu roles, arrow keys, Escape, focus return`, async ({ page }) => {
      const trigger = page.getByRole("button", { name: `${kind} menu` });
      await trigger.focus();
      await page.keyboard.press("Enter");

      const menu = page.getByRole("menu", { name: `${kind} actions` });
      await expect(menu).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Copy text" })).toBeFocused();
      await expect(menu.getByRole("menuitem")).toHaveCount(3);
      await expectClean(page);

      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menuitem", { name: "Reply" })).toBeFocused();
      await page.keyboard.press("End");
      await expect(page.getByRole("menuitem", { name: "Delete" })).toBeFocused();
      await page.keyboard.press("ArrowDown"); // wraps
      await expect(page.getByRole("menuitem", { name: "Copy text" })).toBeFocused();

      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0); // closed → inert, out of the tree
      await expect(trigger).toBeFocused();

      // Activate an item with the keyboard; the click must not reach the row behind.
      const rowClicks = await page.getByTestId("row-clicks").textContent();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("menuitem", { name: "Copy text" })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("picked")).toHaveText("picked: reply");
      // Opening via the trigger is itself one row click; picking the item adds none.
      const before = Number(rowClicks!.replace(/\D/g, ""));
      await expect(page.getByTestId("row-clicks")).toHaveText(`row clicks: ${before + 1}`);
      await expect(trigger).toBeFocused();
    });
  }

  test("AnchoredPopover: keyboard open moves focus in, Tab out closes, mouse open leaves focus", async ({ page }) => {
    const trigger = page.getByRole("button", { name: "Emoji" });
    await trigger.focus();
    await page.keyboard.press("Enter");

    const popup = page.getByRole("dialog", { name: "Emoji picker" });
    await expect(popup).toBeVisible();
    await expect(popup).toBeFocused();
    await expectClean(page);

    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Search emoji")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Smile" })).toBeFocused();
    await page.keyboard.press("Tab"); // past the last control
    await expect(popup).toBeHidden();
    await expect(trigger).toBeFocused();

    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    await expect(trigger).toBeFocused();

    // Opened with the mouse, the popup does not take focus.
    await page.getByRole("heading", { name: "UI primitives" }).click();
    await trigger.click();
    await expect(popup).toBeVisible();
    await expect(popup).not.toBeFocused();
    await page.mouse.click(8, 8);
    await expect(popup).toBeHidden();
  });

  test("MediaLightbox: named dialog, focus on Close, arrows, backdrop press, focus return", async ({ page }) => {
    const thumb = page.getByRole("button", { name: "Open gallery" });
    await thumb.focus();
    await page.keyboard.press("Enter");

    const viewer = page.getByRole("dialog", { name: "Sample gallery" });
    await expect(viewer).toBeVisible();
    await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
    await expectClean(page, '[role="dialog"]');

    await expect(viewer.getByText("Image 1 of 3")).toBeAttached();
    await page.keyboard.press("ArrowRight");
    await expect(viewer.getByText("Image 2 of 3")).toBeAttached();
    await expect(page.getByRole("button", { name: "Previous image" })).toBeVisible();

    // Tab stays inside the viewer.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      expect(await viewer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await expect(thumb).toBeFocused();

    await thumb.click();
    await expect(viewer).toBeVisible();
    await page.mouse.click(8, 300); // backdrop, away from image and controls
    await expect(viewer).toBeHidden();
  });

  test("ImageUpload: Enter and Space on the drop zone open the file picker", async ({ page }) => {
    const group = page.getByRole("group", { name: "Space icon" });
    // Count picker requests instead of waiting for the native dialog, which
    // headless Chrome does not always raise.
    await group.locator('input[type="file"]').evaluate((input: HTMLInputElement) => {
      const counter = window as unknown as { pickerOpens: number };
      counter.pickerOpens = 0;
      input.click = () => {
        counter.pickerOpens += 1;
      };
    });
    const opens = () => page.evaluate(() => (window as unknown as { pickerOpens: number }).pickerOpens);

    const zone = group.getByRole("button", { name: "Upload image or paste URL" });
    await zone.focus();
    await page.keyboard.press("Enter");
    expect(await opens()).toBe(1);
    await page.keyboard.press("Space");
    expect(await opens()).toBe(2);

    await group.getByRole("button", { name: "Paste URL", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Space icon URL" })).toBeVisible();
    await expectClean(page);
  });

  test("Toggle and ColorPicker work from the keyboard", async ({ page }) => {
    const toggle = page.getByRole("switch", { name: "Read receipts" });
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    const hue = page.getByRole("slider", { name: "Hue" });
    await hue.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("color")).toHaveText("221 14% 8%");
    await expect(hue).toHaveAttribute("aria-valuetext", "221°");
  });
});

test.describe("app screens (baseline)", () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMock(page);
    await isolateFromNetwork(page);
  });

  test("the ratchet itself: more nodes or a new rule is a problem, fewer is not", () => {
    const allowed = { "button-name": 1, region: "any" as const };
    expect(compareWithBaseline({ "button-name": 1, region: 40 }, allowed)).toEqual([]);
    expect(compareWithBaseline({}, allowed)).toEqual([]);
    expect(compareWithBaseline({ "button-name": 2 }, allowed)).toEqual([
      "button-name: found 2, baseline allows 1",
    ]);
    expect(compareWithBaseline({ label: 1 }, allowed)).toEqual(["label: found 1, baseline allows 0"]);
    expect(compareWithBaseline({ label: 1 })).toEqual(["label: found 1, baseline allows 0"]);
  });

  test("login screen", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: /generate new identity/i })).toBeVisible({ timeout: 20_000 });
    await expectNoNewViolations(page, "login");
  });

  test("main shell: scan, and Tab never lands on a hidden control", async ({ page }) => {
    await enterShell(page);
    await expectNoNewViolations(page, "shell");

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const hidden: string[] = [];
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      const stop = await focused(page);
      if (stop.inert || !stop.visible) hidden.push(stop.name);
    }
    // Regression: the closed account menu used to put its five invisible
    // buttons in the tab order.
    expect(hidden).toEqual([]);
  });

  test("account menu and the dialog it opens", async ({ page }) => {
    await enterShell(page);

    await expect(page.getByRole("menuitem")).toHaveCount(0); // closed menu is out of the tree
    const account = page.locator("button:has(.truncate.text-sm.font-medium)").last();
    await account.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Edit Profile" })).toBeFocused();
    await expectNoNewViolations(page, "shell:account-menu");

    await page.getByRole("menuitem", { name: "Add Account" }).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Add Account" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await expectNoNewViolations(page, "shell:add-account-dialog", { include: '[role="dialog"]' });

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(account).toBeFocused();
  });

  // Each screen is a lazy route. `ready` lists things only the loaded screen
  // has, so the scan cannot run on (and pass for) a loading placeholder.
  const SCREENS: { screen: string; path: string; ready: (page: Page) => ReturnType<Page["locator"]>[] }[] = [
    {
      screen: "discover",
      path: "/discover",
      ready: (page) => [
        page.getByRole("heading", { level: 1, name: "Discover" }),
        page.getByRole("searchbox", { name: "Search spaces" }),
        page.getByRole("group", { name: "Sort" }),
      ],
    },
    {
      screen: "settings",
      path: "/settings",
      ready: (page) => [
        page.getByRole("heading", { name: "Settings" }).first(),
        page.getByRole("button", { name: "Appearance" }),
        page.getByRole("heading", { name: "Profile Information" }),
        page.getByRole("button", { name: "Save Profile" }),
      ],
    },
    {
      screen: "messages",
      path: "/dm",
      ready: (page) => [
        page.getByRole("heading", { name: "Direct Messages" }),
        page.getByRole("button", { name: "Start a conversation" }),
      ],
    },
  ];

  for (const { screen, path, ready } of SCREENS) {
    test(`${screen} screen`, async ({ page }) => {
      await enterShell(page);
      await navigateInApp(page, path);
      for (const locator of ready(page)) await expect(locator).toBeVisible({ timeout: 20_000 });
      await expectNoNewViolations(page, screen);
    });
  }
});
