import { expect, test, type Page } from "@playwright/test";

const WIDTHS = [1024, 1280, 1366, 1440, 1536, 1728, 1920, 2240] as const;

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

for (const width of WIDTHS) {
  test(`header logo and nav do not intersect at ${width}px`, async ({ page }) => {
    await mockCrowdedHeader(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByTestId("site-header")).toBeVisible();
    await expect(page.locator("header .brand-name")).toBeVisible();

    // Wait for runtime flags so Deal Radar + Scout (More) can appear.
    await expect
      .poll(async () => page.locator("header nav a[href='/radar'], header nav a[href='/scout']").count())
      .toBeGreaterThan(0);

    const logo = page.locator("header .brand");
    const logoBox = await logo.boundingBox();
    expect(logoBox, "logo bounding box").toBeTruthy();

    const targets = page.locator(
      "header nav a.nav-core:visible, header nav a.nav-overflow:visible, header nav .nav-more-btn:visible, header nav .nav-go:visible, header .nav-auth:visible, header .menu-btn:visible",
    );
    const count = await targets.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const box = await targets.nth(i).boundingBox();
      if (!box || box.width < 1 || box.height < 1) continue;
      expect(
        boxesIntersect(logoBox!, box),
        `logo intersects target #${i} (${await targets.nth(i).innerText()}) at ${width}px`,
      ).toBe(false);
    }

    // Wordmark must stay fully inside the brand lockup (no clip under Find).
    const wordmark = page.locator("header .brand-name");
    const wordBox = await wordmark.boundingBox();
    expect(wordBox, "wordmark bounding box").toBeTruthy();
    expect(wordBox!.x).toBeGreaterThanOrEqual(logoBox!.x - 0.5);
    expect(wordBox!.x + wordBox!.width).toBeLessThanOrEqual(logoBox!.x + logoBox!.width + 0.5);
  });
}
