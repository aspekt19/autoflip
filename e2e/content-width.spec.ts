import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Content-width contract (owner layout):
 * Every consumer route: main page column + h1 are horizontally centered
 * (|left gap − right gap| ≤ 8px). Comfortable ~920px column on form pages;
 * wide data boards still sit centered in the padded header width.
 * At 390: full width minus padding (still centered, no overflow).
 */

const ARTIFACT_DIR = join(process.cwd(), "docs/screenshots/content-width");

/** All routes that must not hug the left with empty space on the right. */
const ROUTES: { path: string; slug: string }[] = [
  { path: "/", slug: "home" },
  { path: "/find", slug: "find" },
  { path: "/check", slug: "check" },
  { path: "/resale", slug: "resale" },
  { path: "/radar", slug: "radar" },
  { path: "/activity", slug: "activity" },
  { path: "/pricing", slug: "pricing" },
  { path: "/compare", slug: "compare" },
  { path: "/compare-cars", slug: "compare-cars" },
  { path: "/reports", slug: "reports" },
  { path: "/favorites", slug: "favorites" },
  { path: "/scout", slug: "scout" },
  { path: "/developers", slug: "developers" },
  { path: "/credits", slug: "credits" },
  { path: "/account", slug: "account" },
  { path: "/report/sample", slug: "report-sample" },
  { path: "/login", slug: "login" },
  { path: "/privacy", slug: "privacy" },
  { path: "/terms", slug: "terms" },
];

const MAIN_COL_SELECTOR = [
  ".film-search",
  ".flow-page.site-frame",
  ".sheet-page.site-frame",
  ".sub > .wrap.site-frame",
  ".compare-sheet.site-frame",
].join(", ");

const H1_SELECTOR = "h1.brand-hero-title, .flow-page h1, .sheet-page h1, .sub h1, .compare-hero h1, main h1";

async function mockAccount(page: Page) {
  await page.route("**/api/account", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: false,
        email: null,
        emailVerified: false,
        auth: { configured: true },
        credits: 0,
        freeChecks: { remaining: 3, total: 3, resetsLabel: "1 December 2026 (00:00 UTC)" },
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

type CenterMetrics = {
  leftGap: number;
  rightGap: number;
  gapDelta: number;
  elementWidth: number;
  viewportWidth: number;
};

async function measureCenteredInViewport(page: Page, selector: string): Promise<CenterMetrics | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const leftGap = box.left;
    const rightGap = window.innerWidth - box.right;
    return {
      leftGap,
      rightGap,
      gapDelta: Math.abs(leftGap - rightGap),
      elementWidth: box.width,
      viewportWidth: window.innerWidth,
    };
  }, selector);
}

test.describe("content width + centering — all routes", () => {
  test.beforeAll(() => {
    mkdirSync(join(ARTIFACT_DIR, "after"), { recursive: true });
  });

  for (const route of ROUTES) {
    test(`${route.path} centered main + h1 @ 1440`, async ({ page }) => {
      await mockAccount(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(route.path, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("site-header")).toBeVisible({ timeout: 15_000 });

      const h1 = page.locator(H1_SELECTOR).first();
      await expect(h1).toBeVisible({ timeout: 15_000 });
      const main = page.locator(MAIN_COL_SELECTOR).first();
      await expect(main).toBeVisible({ timeout: 15_000 });

      const heading = await measureCenteredInViewport(page, H1_SELECTOR);
      const column = await measureCenteredInViewport(page, MAIN_COL_SELECTOR);
      expect(heading, `${route.path} h1 metrics`).not.toBeNull();
      expect(column, `${route.path} main column metrics`).not.toBeNull();
      expect(
        heading!.gapDelta,
        `${route.path} h1 |left−right|=${heading!.gapDelta} @ 1440`,
      ).toBeLessThanOrEqual(8);
      expect(
        column!.gapDelta,
        `${route.path} main |left−right|=${column!.gapDelta} @ 1440`,
      ).toBeLessThanOrEqual(8);

      // Comfortable column pages should be noticeably wider than the old ~560px hug.
      if (route.path !== "/compare") {
        expect(
          column!.elementWidth,
          `${route.path} main width=${column!.elementWidth} @ 1440`,
        ).toBeGreaterThanOrEqual(840);
      }

      await page.screenshot({
        path: join(ARTIFACT_DIR, "after", `${route.slug}-1440.png`),
        fullPage: false,
      });
    });

    test(`${route.path} centered main + h1 @ 390`, async ({ page }) => {
      await mockAccount(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(route.path, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("site-header")).toBeVisible({ timeout: 15_000 });

      const h1 = page.locator(H1_SELECTOR).first();
      await expect(h1).toBeVisible({ timeout: 15_000 });
      const main = page.locator(MAIN_COL_SELECTOR).first();
      await expect(main).toBeVisible({ timeout: 15_000 });

      const heading = await measureCenteredInViewport(page, H1_SELECTOR);
      const column = await measureCenteredInViewport(page, MAIN_COL_SELECTOR);
      expect(heading, `${route.path} h1 @ 390`).not.toBeNull();
      expect(column, `${route.path} main @ 390`).not.toBeNull();
      expect(heading!.gapDelta, `${route.path} h1 centering @ 390`).toBeLessThanOrEqual(8);
      expect(column!.gapDelta, `${route.path} main centering @ 390`).toBeLessThanOrEqual(8);

      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        const body = document.body;
        return {
          scrollWidth: Math.max(doc.scrollWidth, body.scrollWidth),
          clientWidth: doc.clientWidth,
        };
      });
      expect(
        overflow.scrollWidth,
        `${route.path} horizontal overflow @ 390`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);
    });
  }

  for (const width of [1440, 1280] as const) {
    test(`home search card width ≥ 840 and not full-bleed @ ${width}`, async ({ page }) => {
      await mockAccount(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      const card = await measureCenteredInViewport(page, ".film-search");
      expect(card).not.toBeNull();
      expect(card!.gapDelta).toBeLessThanOrEqual(8);
      expect(card!.elementWidth).toBeGreaterThanOrEqual(840);
      expect(card!.elementWidth).toBeLessThan(width - 80);
    });
  }
});
