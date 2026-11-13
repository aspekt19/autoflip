import { expect, test, type Page } from "@playwright/test";

/** Phones → tablets → laptops → desktops (incl. ultrawide). */
const WIDTHS = [
  320, 360, 375, 390, 414, 430, 768, 820, 1024, 1280, 1366, 1440, 1536, 1728, 1920, 2240, 2560, 3440,
] as const;

test("browser tab titles are brand-first", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Lemonless");
  await page.goto("/find");
  await expect(page).toHaveTitle("Lemonless · Find a car");
  await page.goto("/check");
  await expect(page).toHaveTitle("Lemonless · Check a car");
  await page.goto("/resale");
  await expect(page).toHaveTitle("Lemonless · Resale");
  await page.goto("/radar");
  await expect(page).toHaveTitle("Lemonless · Deal Radar");
  await page.goto("/pricing");
  await expect(page).toHaveTitle("Lemonless · Pricing");
});

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
  await page.setViewportSize({ width: 2240, height: 900 });
  await page.goto("/");
  await expect
    .poll(async () => page.locator("header nav a[href='/reports']").count())
    .toBeGreaterThan(0);
  await expect(page.locator("header .nav-more-btn")).toBeHidden();
  await expect(page.locator("header nav a.nav-overflow[href='/reports']")).toBeVisible();
  for (const href of ["/scout", "/favorites", "/compare-cars", "/verify", "/developers"]) {
    await expect(page.locator(`header nav a[href='${href}']`)).toHaveCount(0);
  }
  // Agent docs surface as /agents under More (or core on very wide), never /developers.
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
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await page.goto("/");
    await expect(page.getByTestId("site-header")).toBeVisible();
    // Account chip settles after /api/account (credits may be display:none under 720 when Menu is closed).
    await expect(page.locator("header .nav-auth")).toBeVisible();
    await expect
      .poll(async () => page.locator("header nav .nav-go").getAttribute("aria-busy"))
      .not.toBe("true");
    // Flags load into the DOM even when links are in the compact Menu.
    await expect
      .poll(async () => page.locator("header nav a[href='/radar'], header nav a[href='/find']").count())
      .toBeGreaterThan(0);

    const logo = page.locator("header .brand");
    const logoBox = await logo.boundingBox();
    expect(logoBox, "logo bounding box").toBeTruthy();

    // Visible chrome: mark/logo + any shown nav links/More + credits + Account + Menu.
    const targets = page.locator(
      "header .brand, header nav a.nav-core:visible, header nav a.nav-overflow:visible, header nav .nav-more-btn:visible, header nav .nav-go:visible, header .nav-auth:visible, header .menu-btn:visible",
    );
    const count = await targets.count();
    expect(count).toBeGreaterThan(1);

    const boxes: { name: string; box: Box }[] = [];
    for (let i = 0; i < count; i += 1) {
      const el = targets.nth(i);
      const box = await el.boundingBox();
      if (!box || box.width < 1 || box.height < 1) continue;
      const name = (await el.innerText().catch(() => `#${i}`)).trim() || `#${i}`;
      boxes.push({ name, box });
    }
    expect(boxes.length).toBeGreaterThan(1);

    // Pairwise: mark, Menu, credits (when shown), Account, and any inline nav must not overlap.
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        expect(
          boxesIntersect(boxes[i].box, boxes[j].box),
          `${width}px: "${boxes[i].name}" intersects "${boxes[j].name}"`,
        ).toBe(false);
      }
    }

    // When the wordmark is shown, it must stay fully inside the brand lockup.
    const wordmark = page.locator("header .brand-name");
    if (await wordmark.isVisible()) {
      const wordBox = await wordmark.boundingBox();
      expect(wordBox, "wordmark bounding box").toBeTruthy();
      expect(wordBox!.x).toBeGreaterThanOrEqual(logoBox!.x - 0.5);
      expect(wordBox!.x + wordBox!.width).toBeLessThanOrEqual(logoBox!.x + logoBox!.width + 0.5);
    }
  });
}
