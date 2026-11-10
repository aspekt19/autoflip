import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Brand chrome (buttons, labels, nav, kickers) must use Orbitron
 * (--type-brand / --display), not Bebas/Manrope/system.
 * Body paragraphs and field values stay on the sans face (Manrope).
 */

const SCREEN_DIR = join(process.cwd(), "docs/screenshots/brand-type/after");

const PAGES = ["/", "/find", "/check", "/resale", "/radar", "/pricing", "/credits"] as const;

async function mockSignedIn(page: Page) {
  await page.route("**/api/account", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        email: "buyer@example.com",
        emailVerified: true,
        auth: { configured: true },
        credits: 4,
        freeChecks: { remaining: 3, limit: 3, resetsLabel: "1 December 2026 (00:00 UTC)" },
        plans: {
          personal: { status: "inactive", searchLimit: 3 },
          flip: { status: "inactive", searchLimit: 1 },
          billingPortalAvailable: false,
        },
      }),
    });
  });
  await page.route("**/api/product-flags", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        flags: { resaleEvaluate: true, dealRadar: true, scout: true, telegram: false },
      }),
    });
  });
}

function isBrandFace(family: string): boolean {
  // next/font local injects a hashed family that falls back to Orbitron.
  return /orbitron|__display_|type-brand/i.test(family) && !/bebas|impact|__wide_/i.test(family);
}

function isBodyFace(family: string): boolean {
  return /manrope|avenir|__sans_|sans-serif/i.test(family) && !isBrandFace(family);
}

async function fontFamilyOf(page: Page, selector: string, opts?: { visible?: boolean }): Promise<string> {
  const handle = page.locator(selector).first();
  if (opts?.visible === false) {
    await expect(handle).toBeAttached({ timeout: 12_000 });
  } else {
    await expect(handle).toBeVisible({ timeout: 12_000 });
  }
  return handle.evaluate((el) => getComputedStyle(el).fontFamily);
}

test.describe("brand type on chrome", () => {
  test.beforeAll(() => {
    mkdirSync(SCREEN_DIR, { recursive: true });
  });

  test("home hero: Orbitron BUY SMART headline above search (one column @ 1920)", async ({ page }) => {
    await mockSignedIn(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    const title = page.locator("h1.brand-hero-title");
    await expect(title).toBeVisible();
    await expect(title).toHaveText(/BUY SMART\.\s*STAY\s*LEMONLESS\./i);
    const titleFamily = await title.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(isBrandFace(titleFamily), `hero title font-family=${titleFamily}`).toBe(true);

    const search = page.locator(".film-search");
    await expect(search).toBeVisible();
    const stacked = await page.evaluate(() => {
      const slogan = document.querySelector(".film-slogan");
      const card = document.querySelector(".film-search");
      if (!slogan || !card) return false;
      const a = slogan.getBoundingClientRect();
      const b = card.getBoundingClientRect();
      // Search sits below the slogan (not beside it).
      return b.top >= a.bottom - 4;
    });
    expect(stacked, "search card must sit below the slogan at 1920").toBe(true);

    await page.screenshot({ path: join(SCREEN_DIR, "home-hero-1920.png"), fullPage: false });
  });

  for (const path of PAGES) {
    test(`${path} buttons and labels use Orbitron brand face`, async ({ page }) => {
      await mockSignedIn(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(path);
      await expect(page.getByTestId("site-header")).toBeVisible();

      // Account chip is always painted; primary links may collapse into More on mid widths.
      const authFamily = await fontFamilyOf(page, "header .nav-auth");
      expect(isBrandFace(authFamily), `${path} nav-auth font-family=${authFamily}`).toBe(true);

      const more = page.locator("header .nav-more-btn");
      if ((await more.count()) > 0 && (await more.isVisible().catch(() => false))) {
        const moreFamily = await more.evaluate((el) => getComputedStyle(el).fontFamily);
        expect(isBrandFace(moreFamily), `${path} More font-family=${moreFamily}`).toBe(true);
      } else {
        const navFamily = await fontFamilyOf(page, "header nav a.nav-core", { visible: false });
        expect(isBrandFace(navFamily), `${path} nav-core font-family=${navFamily}`).toBe(true);
      }

      // CTA / chrome button when present on the page.
      const action = page.locator("a.action, button.action, a.quiet, button.quiet").first();
      if ((await action.count()) > 0) {
        const actionFamily = await action.evaluate((el) => getComputedStyle(el).fontFamily);
        expect(isBrandFace(actionFamily), `${path} .action/.quiet font-family=${actionFamily}`).toBe(true);
      }

      const kicker = page.locator(".kicker, .eyebrow, .sheet-label, .field legend, .field > label").first();
      if ((await kicker.count()) > 0) {
        const kickerFamily = await kicker.evaluate((el) => getComputedStyle(el).fontFamily);
        expect(isBrandFace(kickerFamily), `${path} label/kicker font-family=${kickerFamily}`).toBe(true);
      }

      // Body copy must remain the sans face (exclude kickers/eyebrows which are brand chrome).
      const lead = page.locator("p.lead, main p.hint, main .choice-desc").first();
      if ((await lead.count()) > 0 && (await lead.isVisible().catch(() => false))) {
        const leadFamily = await lead.evaluate((el) => getComputedStyle(el).fontFamily);
        expect(isBodyFace(leadFamily), `${path} body paragraph font-family=${leadFamily}`).toBe(true);
      }

      const slug = path === "/" ? "home" : path.slice(1);
      await page.screenshot({
        path: join(SCREEN_DIR, `${slug}-1440.png`),
        fullPage: false,
      });
    });
  }
});
