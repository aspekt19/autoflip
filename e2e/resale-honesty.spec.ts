import { expect, test, type Page } from "@playwright/test";
import { evaluateListingPrice } from "../src/domain/price-evaluation";
import { buildResaleAssessment } from "../src/domain/resale-evaluate";
import type { Listing } from "../src/domain/types";

/** Deal Radar is ON by default; Scout/Telegram stay OFF unless explicitly enabled. */
const FLAGS = {
  resaleEvaluate: true,
  dealRadar: true,
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
  const subject = car({ vin: "5J6RM4H75GL000001", year: 2018, miles: 70_000, priceUsd: 8_000 });
  const pool = [
    subject,
    car({ vin: "5J6RM4H75GL000002", year: 2017, miles: 72_000, priceUsd: 14_500 }),
    car({ vin: "5J6RM4H75GL000003", year: 2018, miles: 68_000, priceUsd: 15_200 }),
    car({ vin: "5J6RM4H75GL000004", year: 2019, miles: 55_000, priceUsd: 16_800 }),
    car({ vin: "5J6RM4H75GL000005", year: 2016, miles: 90_000, priceUsd: 12_900 }),
  ];
  const evaluation = evaluateListingPrice(subject, pool, { mode: "flip" });
  return buildResaleAssessment({
    askingUsd: 8_000,
    miles: 70_000,
    accidentCount: null,
    evaluation,
    repairAbility: "unknown",
    targetProfitUsd: 1_500,
  });
}

async function mockFlags(page: Page, flags = FLAGS) {
  await page.route("**/api/product-flags", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ flags }),
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
        auth: { configured: true },
        credits: authenticated ? 3 : 0,
        freeChecks: authenticated
          ? { remaining: 3, limit: 3, resetsLabel: "next month" }
          : null,
      }),
    });
  });
}

async function scoutTelegramHrefs(page: Page) {
  return page.locator("a").evaluateAll((els) =>
    els
      .map((el) => el.getAttribute("href") ?? "")
      .filter((href) => /\/scout|telegram/i.test(href)),
  );
}

test("Scout and Telegram stay hidden; Deal Radar is available when default-on", async ({ page }) => {
  await mockFlags(page);
  await mockAccount(page, false);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Resale" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Deal Radar" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Scout" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /telegram/i })).toHaveCount(0);
    expect(await scoutTelegramHrefs(page)).toEqual([]);
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/radar");
  await expect(page.getByRole("heading", { name: "Deal Radar" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Not available" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /connect telegram/i })).toHaveCount(0);

  await page.goto("/developers");
  await expect(page.getByRole("heading", { name: "For agents" })).toBeVisible();
  expect(await scoutTelegramHrefs(page)).toEqual([]);
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
