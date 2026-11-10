import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Owner home-hero contract: card above h1, wide card, marquee filled at t=0. */

const ARTIFACT_DIR = join(process.cwd(), "docs/screenshots/home-hero");

async function mockAccount(page: Page) {
  await page.route("**/api/account", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        email: "buyer@example.com",
        emailVerified: true,
        auth: { configured: true },
        credits: 3,
        freeChecks: { remaining: 3, limit: 3, resetsLabel: "1 December 2026 (00:00 UTC)" },
        plans: {
          personal: { status: "inactive", searchLimit: 3 },
          flip: { status: "inactive", searchLimit: 1 },
          billingPortalAvailable: false,
        },
      }),
    });
  });
}

test.beforeAll(() => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
});

test.describe("home hero layout", () => {
  test("search card sits above h1", async ({ page }) => {
    await mockAccount(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const order = await page.evaluate(() => {
      const card = document.querySelector(".film-search");
      const h1 = document.querySelector("h1.brand-hero-title");
      if (!card || !h1) return null;
      const c = card.getBoundingClientRect();
      const t = h1.getBoundingClientRect();
      return { cardBottom: c.bottom, h1Top: t.top };
    });
    expect(order).not.toBeNull();
    expect(order!.h1Top).toBeGreaterThanOrEqual(order!.cardBottom - 4);
  });

  for (const width of [1440, 1728, 390] as const) {
    test(`screenshot @ ${width}`, async ({ page }) => {
      await mockAccount(page);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto("/");
      await expect(page.locator(".film-search")).toBeVisible();
      await expect(page.locator("h1.brand-hero-title")).toBeVisible();
      await page.screenshot({
        path: join(ARTIFACT_DIR, `home-hero-${width}.png`),
        fullPage: false,
      });
    });
  }
});
