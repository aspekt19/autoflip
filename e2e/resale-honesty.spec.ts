import { expect, test, type Page } from "@playwright/test";
import { evaluateListingPrice } from "../src/domain/price-evaluation";
import { buildResaleAssessment } from "../src/domain/resale-evaluate";
import type { Listing } from "../src/domain/types";

const FLAGS = {
  resaleEvaluate: true,
  dealRadar: false,
  scout: false,
  telegram: false,
};

function car(partial: Partial<Listing> & Pick<Listing, "vin" | "year" | "miles" | "priceUsd">): Listing {
  return {
    make: "Honda",
    model: "CR-V",
    trim: "EX",
    city: null,
    state: null,
    zip: "68114",
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    askingPriceKind: "purchase_ask",
    ...partial,
  };
}

function pricedAssessment() {
  const subject = car({ vin: "RESALE-SUBJECT", year: 2018, miles: 70_000, priceUsd: 8_000 });
  const pool = [
    subject,
    car({ vin: "1", year: 2017, miles: 68_000, priceUsd: 16_400 }),
    car({ vin: "2", year: 2018, miles: 62_000, priceUsd: 17_200 }),
    car({ vin: "3", year: 2019, miles: 55_000, priceUsd: 18_100 }),
    car({ vin: "4", year: 2018, miles: 74_000, priceUsd: 15_900 }),
    car({ vin: "5", year: 2016, miles: 80_000, priceUsd: 14_800 }),
  ];
  const evaluation = evaluateListingPrice(subject, pool, { mode: "flip" });
  const assessment = buildResaleAssessment({
    askingUsd: 8_000,
    miles: 70_000,
    accidentCount: null,
    evaluation,
  });
  return assessment;
}

async function mockFlags(page: Page) {
  await page.route("**/api/product-flags", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ flags: FLAGS }),
    });
  });
}

async function mockAccount(page: Page, authenticated: boolean) {
  await page.route("**/api/account", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated,
        email: authenticated ? "buyer@example.com" : null,
        emailVerified: authenticated,
        auth: { configured: true },
        credits: authenticated ? 2 : 0,
        freeChecks: authenticated
          ? { remaining: 3, limit: 3, resetsLabel: "1 December 2026 (00:00 UTC)" }
          : null,
      }),
    });
  });
}

async function hiddenHrefs(page: Page) {
  return page.locator("a").evaluateAll((els) =>
    els
      .map((el) => el.getAttribute("href") ?? "")
      .filter((href) => /\/radar|\/scout|\/activity|telegram/i.test(href)),
  );
}

test("hidden Deal Radar, Scout, and Telegram are not linked when flags are off", async ({ page }) => {
  await mockFlags(page);
  await mockAccount(page, false);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Resale" }).first()).toBeVisible();
    expect(await hiddenHrefs(page)).toEqual([]);
    await expect(page.getByRole("link", { name: "Deal Radar" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Scout" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /telegram/i })).toHaveCount(0);
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/radar");
  await expect(page.getByRole("heading", { name: "Not available" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Resale estimate" })).toBeVisible();
  await expect(page.getByRole("button", { name: /connect telegram/i })).toHaveCount(0);
  await expect(page.getByLabel(/saved search|watch/i)).toHaveCount(0);
  expect(await hiddenHrefs(page)).toEqual([]);

  await page.goto("/activity");
  await expect(page.getByRole("heading", { name: "Not available" })).toBeVisible();
  expect(await hiddenHrefs(page)).toEqual([]);

  await page.goto("/developers");
  await expect(page.getByText(/does not link to it/i)).toBeVisible();
  expect(await hiddenHrefs(page)).toEqual([]);

  await page.goto("/pricing");
  await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();
  const start = page.getByRole("button", { name: "Not available in this preview" });
  await expect(start.first()).toBeDisabled();
  expect(await hiddenHrefs(page)).toEqual([]);
});

test("resale requires sign-in and shows an estimate only from similar listings", async ({ page }) => {
  await mockFlags(page);
  await mockAccount(page, false);
  await page.goto("/resale");
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await expect(page.locator("#resale-year")).toHaveCount(0);
  await expect(page.getByText(/^Buy ceiling/)).toHaveCount(0);

  await mockAccount(page, true);
  const assessment = pricedAssessment();
  expect(assessment.ok).toBe(true);
  await page.route("**/api/resale/evaluate", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, title: "2018 Honda CR-V", sample: false, assessment }),
    });
  });
  await page.goto("/resale");
  await expect(page.locator("#resale-year")).toBeVisible();
  await expect(page.getByText(/not a profit guarantee/i).first()).toBeVisible();
  await expect(page.getByText(/^Buy ceiling/)).toHaveCount(0);

  await page.locator("#resale-make").fill("Honda");
  await page.locator("#resale-model").fill("CR-V");
  await page.locator("#resale-miles").fill("70000");
  await page.locator("#resale-ask").fill("8000");
  await page.getByRole("button", { name: "Estimate resale" }).click();
  await expect(page.getByRole("heading", { name: "2018 Honda CR-V" })).toBeVisible();
  await expect(page.getByText(/Buy ceiling/)).toBeVisible();
  await expect(page.getByText(/not a known accident/i)).toBeVisible();
  await expect(page.getByText(/not a profit guarantee/i).first()).toBeVisible();
  await expect(page.getByText(/example assumption/i).first()).toBeVisible();
  if (assessment.ok) {
    await expect(page.getByText("$8,000").first()).toBeVisible();
    const mid = assessment.resaleMidUsd.toLocaleString("en-US");
    await expect(page.getByText(`Mid: $${mid}`)).toBeVisible();
    expect(assessment.resaleMidUsd).toBeGreaterThan(12_000);
    expect(assessment.resaleMidUsd).not.toBe(8_000);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
