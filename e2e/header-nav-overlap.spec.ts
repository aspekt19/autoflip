import { expect, test, type Page } from "@playwright/test";

const WIDTHS = [1024, 1280, 1366, 1440, 1536, 1728, 1920, 2240, 2560, 3440] as const;

test("home hero film fills the viewport under an overlaid header", async ({ page }) => {
  await page.setViewportSize({ width: 2240, height: 1260 });
  await page.goto("/");
  await expect(page.getByTestId("site-header")).toHaveClass(/bar-over-media/);

  const metrics = await page.evaluate(() => {
    const sticky = document.querySelector(".film-sticky");
    if (!sticky) return null;
    const rect = sticky.getBoundingClientRect();
    const header = document.querySelector("header.bar")!;
    const before = getComputedStyle(header, "::before");
    const headerBottom = header.getBoundingClientRect().bottom;
    // Just below the full-bleed header, the film must be the hit target (no black curtain).
    const y = Math.min(headerBottom + 8, window.innerHeight - 2);
    const hit = document.elementFromPoint(80, y);
    const hitClass = hit instanceof Element ? hit.className.toString() : String(hit?.nodeName ?? "");
    return {
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
      viewportH: window.innerHeight,
      beforeContent: before.content,
      hitClass,
      headerWidth: header.getBoundingClientRect().width,
      viewportW: window.innerWidth,
    };
  });
  expect(metrics).toBeTruthy();
  expect(metrics!.top).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics!.height - metrics!.viewportH)).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics!.bottom - metrics!.viewportH)).toBeLessThanOrEqual(1);
  expect(metrics!.beforeContent === "none" || metrics!.beforeContent === "normal").toBe(true);
  expect(metrics!.hitClass).toMatch(/film-(canvas|poster|stage|sticky)/);
  // Header spans the viewport (fluid pad is inside the bar).
  expect(Math.abs(metrics!.headerWidth - metrics!.viewportW)).toBeLessThanOrEqual(1);
});
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

test("wide viewport shows all primary links without More", async ({ page }) => {
  await mockCrowdedHeader(page);
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto("/");
  await expect
    .poll(async () => page.locator("header nav a[href='/scout']").count())
    .toBeGreaterThan(0);
  await expect(page.locator("header .nav-more-btn")).toBeHidden();
  for (const href of ["/scout", "/reports", "/favorites", "/compare-cars"]) {
    await expect(page.locator(`header nav a.nav-overflow[href='${href}']`)).toBeVisible();
  }
});

test("mid viewport keeps overflow destinations under More", async ({ page }) => {
  await mockCrowdedHeader(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect
    .poll(async () => page.locator("header .nav-more-btn").count())
    .toBeGreaterThan(0);
  await expect(page.locator("header .nav-more-btn")).toBeVisible();
  await expect(page.locator("header nav a.nav-overflow[href='/reports']")).toBeHidden();
});

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
