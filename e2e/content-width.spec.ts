import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Content-width contract (owner layout):
 * Centered, comfortably wide column (~920px) — not the old narrow left card,
 * and not edge-to-edge with the header. At 1440/1280: centered
 * (|left−right| ≤ 8px) and width ≥ 840px. At 390: full width minus padding.
 */

const ARTIFACT_DIR = join(process.cwd(), "docs/screenshots/content-width");

async function mockSignedOut(page: Page) {
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

test.describe("content width + centering", () => {
  test.beforeAll(() => {
    mkdirSync(join(ARTIFACT_DIR, "after"), { recursive: true });
  });

  for (const width of [1440, 1280] as const) {
    test(`home hero + search card centered column @ ${width}`, async ({ page }) => {
      await mockSignedOut(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator("h1.brand-hero-title")).toBeVisible();
      await expect(page.locator(".film-search")).toBeVisible();

      const title = await measureCenteredInViewport(page, "h1.brand-hero-title");
      const card = await measureCenteredInViewport(page, ".film-search");
      expect(title, "hero title metrics").not.toBeNull();
      expect(card, "search card metrics").not.toBeNull();
      expect(title!.gapDelta, `title |left−right| @ ${width} = ${title!.gapDelta}`).toBeLessThanOrEqual(8);
      expect(card!.gapDelta, `card |left−right| @ ${width} = ${card!.gapDelta}`).toBeLessThanOrEqual(8);
      expect(card!.elementWidth, `card width @ ${width} = ${card!.elementWidth}`).toBeGreaterThanOrEqual(840);
      // Not edge-to-edge with the viewport (comfortable column, not full header).
      expect(card!.elementWidth, `card must stay under full viewport @ ${width}`).toBeLessThan(width - 80);

      await page.screenshot({
        path: join(ARTIFACT_DIR, "after", `home-${width}.png`),
        fullPage: false,
      });
    });

    test(`/find main panel centered column @ ${width}`, async ({ page }) => {
      await mockSignedOut(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/find");
      await expect(page.locator(".flow-page h1")).toBeVisible();
      const panel = page.locator(".flow-page .onboarding-note, .flow-page .sign-in-gate").first();
      await expect(panel).toBeVisible();

      const heading = await measureCenteredInViewport(page, ".flow-page h1");
      const panelMetrics = await measureCenteredInViewport(
        page,
        ".flow-page .sign-in-gate, .flow-page .onboarding-note",
      );
      expect(heading, "find heading").not.toBeNull();
      expect(heading!.gapDelta, `find h1 centering @ ${width}`).toBeLessThanOrEqual(8);
      expect(panelMetrics, "find panel").not.toBeNull();
      expect(panelMetrics!.gapDelta, `find panel centering @ ${width}`).toBeLessThanOrEqual(8);
      expect(
        panelMetrics!.elementWidth,
        `find panel width @ ${width} = ${panelMetrics!.elementWidth}`,
      ).toBeGreaterThanOrEqual(840);

      await page.screenshot({
        path: join(ARTIFACT_DIR, "after", `find-${width}.png`),
        fullPage: false,
      });
    });

    test(`/check main panel centered column @ ${width}`, async ({ page }) => {
      await mockSignedOut(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/check");
      await expect(page.locator(".flow-page h1")).toBeVisible();

      const heading = await measureCenteredInViewport(page, ".flow-page h1");
      const panelMetrics = await measureCenteredInViewport(
        page,
        ".flow-page .sign-in-gate, .flow-page .onboarding-note",
      );
      expect(heading, "check heading").not.toBeNull();
      expect(heading!.gapDelta, `check h1 centering @ ${width}`).toBeLessThanOrEqual(8);
      expect(panelMetrics, "check panel").not.toBeNull();
      expect(panelMetrics!.gapDelta, `check panel centering @ ${width}`).toBeLessThanOrEqual(8);
      expect(
        panelMetrics!.elementWidth,
        `check panel width @ ${width} = ${panelMetrics!.elementWidth}`,
      ).toBeGreaterThanOrEqual(840);

      await page.screenshot({
        path: join(ARTIFACT_DIR, "after", `check-${width}.png`),
        fullPage: false,
      });
    });
  }

  test("home @ 390 full width minus padding, no overflow", async ({ page }) => {
    await mockSignedOut(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.locator(".film-search")).toBeVisible();

    const metrics = await page.evaluate(() => {
      const card = document.querySelector(".film-search");
      const frame = document.querySelector(".film-copy.site-frame");
      const doc = document.documentElement;
      const body = document.body;
      const box = card?.getBoundingClientRect();
      const fs = frame ? getComputedStyle(frame) : null;
      const padL = fs ? Number.parseFloat(fs.paddingLeft) || 0 : 0;
      const padR = fs ? Number.parseFloat(fs.paddingRight) || 0 : 0;
      const available = window.innerWidth - padL - padR;
      return {
        scrollWidth: Math.max(doc.scrollWidth, body.scrollWidth),
        clientWidth: doc.clientWidth,
        cardWidth: box?.width ?? 0,
        available,
        widthDelta: Math.abs((box?.width ?? 0) - available),
      };
    });
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(
      metrics.widthDelta,
      `card should fill padded width @ 390 (delta ${metrics.widthDelta})`,
    ).toBeLessThanOrEqual(8);

    await page.screenshot({
      path: join(ARTIFACT_DIR, "after", "home-390.png"),
      fullPage: false,
    });
  });

  test("find @ 390 full width minus padding, no overflow", async ({ page }) => {
    await mockSignedOut(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/find");
    await expect(page.locator(".flow-page")).toBeVisible();
    const metrics = await page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      const frame = document.querySelector(".flow-page.site-frame");
      const box = frame?.getBoundingClientRect();
      return {
        scrollWidth: Math.max(doc.scrollWidth, body.scrollWidth),
        clientWidth: doc.clientWidth,
        frameWidth: box?.width ?? 0,
        leftGap: box?.left ?? 0,
        rightGap: window.innerWidth - (box?.right ?? 0),
      };
    });
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(Math.abs(metrics.leftGap - metrics.rightGap)).toBeLessThanOrEqual(8);
    expect(metrics.frameWidth).toBeGreaterThan(300);
    await page.screenshot({
      path: join(ARTIFACT_DIR, "after", "find-390.png"),
      fullPage: false,
    });
  });
});
