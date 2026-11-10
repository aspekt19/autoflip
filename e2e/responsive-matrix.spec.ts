import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Full responsive matrix: every consumer route × phone/tablet/laptop/desktop widths.
 * Asserts no document horizontal scroll and no header/logo/nav intersection.
 * Screenshots land in test-results/responsive-screenshots for CI artifacts.
 */

const SCREEN_DIR = join(process.cwd(), "test-results", "responsive-screenshots");

const ROUTES = [
  { path: "/", slug: "home" },
  { path: "/find", slug: "find" },
  { path: "/check", slug: "check" },
  { path: "/resale", slug: "resale" },
  { path: "/radar", slug: "radar" },
  { path: "/pricing", slug: "pricing" },
  { path: "/credits", slug: "credits" },
  { path: "/compare", slug: "compare" },
  { path: "/reports", slug: "reports" },
  { path: "/favorites", slug: "saved-cars" },
  { path: "/report/sample", slug: "report-sample" },
  { path: "/developers", slug: "developers" },
  { path: "/login", slug: "sign-in" },
] as const;

/** Phones (portrait), tablets (portrait + landscape), laptops, desktops. */
const VIEWPORTS: { name: string; width: number; height: number }[] = [
  { name: "phone-320", width: 320, height: 568 },
  { name: "phone-360", width: 360, height: 640 },
  { name: "phone-375", width: 375, height: 667 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "phone-414", width: 414, height: 896 },
  { name: "phone-430", width: 430, height: 932 },
  { name: "tablet-768-portrait", width: 768, height: 1024 },
  { name: "tablet-768-landscape", width: 1024, height: 768 },
  { name: "tablet-820-portrait", width: 820, height: 1180 },
  { name: "tablet-820-landscape", width: 1180, height: 820 },
  { name: "tablet-1024-portrait", width: 1024, height: 1366 },
  { name: "tablet-1024-landscape", width: 1366, height: 1024 },
  { name: "laptop-1280", width: 1280, height: 800 },
  { name: "laptop-1366", width: 1366, height: 768 },
  { name: "laptop-1440", width: 1440, height: 900 },
  { name: "desktop-1728", width: 1728, height: 1117 },
  { name: "desktop-1920", width: 1920, height: 1080 },
  { name: "desktop-2240", width: 2240, height: 1260 },
  { name: "desktop-2560", width: 2560, height: 1440 },
];

type Box = { x: number; y: number; width: number; height: number };

function boxesIntersect(a: Box, b: Box): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

async function mockCrowdedHeader(page: Page) {
  await page.route("**/api/product-flags", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        flags: { resaleEvaluate: true, dealRadar: true, scout: true, telegram: false },
      }),
    });
  });
  await page.route("**/api/scout", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ capabilities: { uiEnabled: true } }),
    });
  });
  await page.route("**/api/account", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        email: "buyer@example.com",
        emailVerified: true,
        auth: { configured: true },
        credits: 12,
        freeChecks: { remaining: 3, total: 3, resetsLabel: "1 December 2026 (00:00 UTC)" },
      }),
    });
  });
}

async function assertNoHorizontalScroll(page: Page, label: string) {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      scrollWidth: Math.max(doc.scrollWidth, body.scrollWidth),
      clientWidth: doc.clientWidth,
      innerWidth: window.innerWidth,
    };
  });
  expect(
    metrics.scrollWidth,
    `${label}: document scrollWidth ${metrics.scrollWidth} > viewport ${metrics.clientWidth}`,
  ).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function settleHeader(page: Page) {
  await expect(page.getByTestId("site-header")).toBeVisible();
  await expect(page.locator("header .nav-auth")).toBeVisible();
  // Credits chip is display:none under 720px when the menu is closed — only wait for load settle.
  await expect
    .poll(async () => page.locator("header nav .nav-go").getAttribute("aria-busy"))
    .not.toBe("true");
}

async function assertHeaderNoOverlap(page: Page, label: string) {
  await settleHeader(page);

  const logo = page.locator("header .brand");
  const logoBox = await logo.boundingBox();
  expect(logoBox, `${label}: logo box`).toBeTruthy();

  // Same contract as header-nav-overlap: logo must not intersect any visible chrome control.
  const targets = page.locator(
    "header nav a.nav-core:visible, header nav a.nav-overflow:visible, header nav .nav-more-btn:visible, header nav .nav-go:visible, header .nav-auth:visible, header .menu-btn:visible, header .nav-more-panel a:visible",
  );
  const count = await targets.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i += 1) {
    const el = targets.nth(i);
    const box = await el.boundingBox();
    if (!box || box.width < 1 || box.height < 1) continue;
    const name = (await el.innerText().catch(() => `#${i}`)).trim() || `#${i}`;
    expect(boxesIntersect(logoBox!, box), `${label}: logo intersects "${name}"`).toBe(false);
  }
}

function shotPath(routeSlug: string, viewportName: string, suffix = ""): string {
  mkdirSync(SCREEN_DIR, { recursive: true });
  const extra = suffix ? `-${suffix}` : "";
  return join(SCREEN_DIR, `${routeSlug}--${viewportName}${extra}.png`);
}

test.describe("responsive matrix", () => {
  for (const route of ROUTES) {
    for (const vp of VIEWPORTS) {
      test(`${route.path} @ ${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
        await mockCrowdedHeader(page);
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(route.path);
        const label = `${route.path} @ ${vp.name}`;
        await settleHeader(page);
        await assertNoHorizontalScroll(page, label);
        await assertHeaderNoOverlap(page, label);

        await page.screenshot({
          path: shotPath(route.slug, vp.name),
          fullPage: false,
        });
      });
    }
  }

  test("mobile menu opens without horizontal scroll or header overlap @ 390", async ({ page }) => {
    await mockCrowdedHeader(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    // Hydration + account chip — same gate as existing nav e2e.
    await expect(page.getByRole("link", { name: /Account/i })).toBeVisible();
    const menuBtn = page.locator("header .menu-btn");
    await expect(menuBtn).toBeVisible();
    await menuBtn.click();
    const primaryNav = page.getByRole("navigation", { name: "Primary" });
    await expect(primaryNav.getByRole("link", { name: "Find" })).toBeVisible();
    await expect(menuBtn).toHaveAttribute("aria-expanded", "true");
    await expect(menuBtn).toHaveAttribute("aria-label", "Close menu");
    await assertNoHorizontalScroll(page, "mobile menu @ 390");
    await assertHeaderNoOverlap(page, "mobile menu @ 390");
    await page.screenshot({ path: shotPath("home", "phone-390", "mobile-menu"), fullPage: false });
  });

  test("More menu opens without horizontal scroll or header overlap @ 1440", async ({ page }) => {
    await mockCrowdedHeader(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("link", { name: /Account/i })).toBeVisible();
    // Wait for runtime flags so overflow destinations populate More.
    const more = page.getByRole("button", { name: "More" });
    await expect(more).toBeVisible();
    await more.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await assertNoHorizontalScroll(page, "More menu @ 1440");
    await assertHeaderNoOverlap(page, "More menu @ 1440");
    await page.screenshot({ path: shotPath("home", "laptop-1440", "more-menu"), fullPage: false });
  });
});
