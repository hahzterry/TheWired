/**
 * Virtualized lists, in a real browser with real layout (which the unit tests
 * cannot have): a long DM conversation mounts only a window of rows, opens on
 * its newest message, keeps the reader's place when history arrives above,
 * and comes back to the bottom on request.
 *
 * No relay or backend is needed: the conversation is put straight into the
 * app's store. Network noise is filtered; only app-level errors fail the run.
 */
import { test, expect, type Page } from "@playwright/test";
import { installTauriMock } from "./support/tauriKeystoreMock";
import { installConsoleGuard, appErrors, loginGenerate } from "./helpers/session";

const PARTNER = "c".repeat(64);
const LIST = '[data-testid="dm-message-list"]';
const TOTAL = 1500;

/** The app's Redux store, read off the React tree (no module URL needed). */
async function installStoreAccess(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __e2eStore?: () => unknown; __e2eStoreRef?: unknown };
    w.__e2eStore = () => {
      if (w.__e2eStoreRef) return w.__e2eStoreRef;
      const root = document.getElementById("root") as (HTMLElement & Record<string, unknown>) | null;
      if (!root) return null;
      const key = Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
      if (!key) return null;
      let fiber = root[key] as { stateNode?: { current?: unknown }; child?: unknown; sibling?: unknown; memoizedProps?: { store?: { getState?: unknown; dispatch?: unknown } } };
      fiber = ((fiber.stateNode && fiber.stateNode.current) || fiber) as typeof fiber;
      const queue: (typeof fiber)[] = [fiber];
      for (let seen = 0; queue.length && seen < 5000; seen++) {
        const f = queue.shift()!;
        const store = f.memoizedProps?.store;
        if (store && typeof store.getState === "function" && typeof store.dispatch === "function") {
          w.__e2eStoreRef = store;
          return store;
        }
        if (f.child) queue.push(f.child as typeof fiber);
        if (f.sibling) queue.push(f.sibling as typeof fiber);
      }
      return null;
    };
  });
}

/** Add `count` messages to the conversation; `where` decides older or newer than what is there. */
async function addMessages(page: Page, count: number, where: "seed" | "head" | "tail", label: string): Promise<void> {
  await page.evaluate(
    ({ partner, count, where, label }) => {
      const store = (window as unknown as { __e2eStore: () => { getState: () => { identity: { pubkey: string }; dm: { messages: Record<string, { createdAt: number }[]> } }; dispatch: (a: unknown) => void } }).__e2eStore();
      const me = store.getState().identity.pubkey;
      const existing = store.getState().dm.messages[partner] ?? [];
      const times = existing.map((m) => m.createdAt);
      const now = Math.floor(Date.now() / 1000);
      const start =
        where === "head" ? Math.min(...times) - count * 60 - 60 : where === "tail" ? Math.max(...times) + 60 : now - count * 60;
      for (let i = 0; i < count; i++) {
        const id = `${label}-${i}-${Math.random().toString(16).slice(2)}`.padEnd(64, "0");
        store.dispatch({
          type: "dm/addDMMessage",
          payload: {
            partnerPubkey: partner,
            myPubkey: me,
            message: {
              id,
              rumorId: id,
              wrapId: `w-${id}`.slice(0, 64),
              senderPubkey: i % 3 === 0 ? me : partner,
              // Every seventh message is taller, so rows vary in height.
              content: `${label} ${i}${i % 7 === 3 ? "\nwith a second line\nand a third" : ""}`,
              createdAt: start + i * 60,
            },
          },
        });
      }
    },
    { partner: PARTNER, count, where, label },
  );
}

async function closeOnboarding(page: Page): Promise<void> {
  const close = () =>
    page.evaluate(() => {
      const store = (window as unknown as { __e2eStore: () => { dispatch: (a: unknown) => void } }).__e2eStore();
      store.dispatch({ type: "onboarding/setShowProfileWizard", payload: false });
      store.dispatch({ type: "onboarding/setShowAppTour", payload: false });
    });
  await close();
  await page.waitForTimeout(1_500);
  await close();
  await expect(page.getByRole("heading", { name: "Welcome to The Wired" })).toHaveCount(0);
}

/** In-app navigation: a full page load would drop the seeded store. */
async function navigate(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

const gapToBottom = (page: Page) =>
  page.locator(LIST).evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));

/** The first message row whose bottom is below the list's top edge. */
const topRow = (page: Page) =>
  page.locator(LIST).evaluate((el) => {
    const edge = el.getBoundingClientRect().top;
    for (const row of el.querySelectorAll("[data-wrap-id]")) {
      const r = row.getBoundingClientRect();
      if (r.bottom > edge + 1 && r.height > 0) {
        return { id: row.getAttribute("data-wrap-id"), offset: Math.round(r.top - edge) };
      }
    }
    return null;
  });

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
});

test("a long DM conversation is windowed, opens at the bottom and keeps the reader's place", async ({ page }) => {
  test.setTimeout(120_000);
  const guard = installConsoleGuard(page);
  await loginGenerate(page);
  await installStoreAccess(page);
  await navigate(page, "/dm");
  await addMessages(page, TOTAL, "seed", "msg");
  await navigate(page, `/dm/${PARTNER}`);

  const list = page.locator(LIST);
  await expect(list).toBeVisible({ timeout: 20_000 });
  // The first-run wizard and tour sit over the list for a fresh account and
  // would swallow the wheel. They are not what this spec is about: close them
  // in the store (they can show up late, after the async auto-login).
  await closeOnboarding(page);

  // Opens on the newest message, at the bottom.
  await expect(list.getByText(`msg ${TOTAL - 1}`, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => gapToBottom(page), { timeout: 10_000 }).toBeLessThanOrEqual(2);

  // Only a window of the conversation is mounted.
  const mounted = await list.locator("[data-wrap-id]").count();
  expect(mounted).toBeGreaterThan(5);
  expect(mounted).toBeLessThan(120);
  await expect(list.getByText("msg 0", { exact: true })).toHaveCount(0);

  // A message arriving while at the bottom is followed.
  await addMessages(page, 1, "tail", "live");
  await expect(list.getByText("live 0", { exact: true })).toBeVisible();
  await expect.poll(() => gapToBottom(page)).toBeLessThanOrEqual(2);

  // The reader scrolls up into history: the scroll-to-bottom button appears.
  const box = (await list.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, -700);
    await page.waitForTimeout(40);
  }
  const toBottom = page.getByTitle("Scroll to bottom");
  await expect(toBottom).toBeVisible();
  await page.waitForTimeout(1_200); // let the scroll settle
  const before = await topRow(page);
  expect(before).not.toBeNull();

  // Older history arrives above: what the reader is looking at does not move.
  await addMessages(page, 80, "head", "older");
  await page.waitForTimeout(800);
  const afterHistory = await topRow(page);
  expect(afterHistory!.id).toBe(before!.id);
  expect(Math.abs(afterHistory!.offset - before!.offset)).toBeLessThanOrEqual(2);

  // A new message arrives below: still no movement, and it is not followed.
  await addMessages(page, 1, "tail", "later");
  await page.waitForTimeout(500);
  const afterLive = await topRow(page);
  expect(afterLive!.id).toBe(before!.id);
  expect(Math.abs(afterLive!.offset - before!.offset)).toBeLessThanOrEqual(2);

  // Back to the newest message.
  await toBottom.click();
  await expect(list.getByText("later 0", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => gapToBottom(page), { timeout: 10_000 }).toBeLessThanOrEqual(2);
  await expect(toBottom).toBeHidden();

  // Still windowed after all of that.
  expect(await list.locator("[data-wrap-id]").count()).toBeLessThan(120);
  expect(appErrors(guard.errors())).toEqual([]);
});
