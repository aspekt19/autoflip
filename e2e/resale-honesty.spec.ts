import { expect, test, type Page } from "@playwright/test";
import { evaluateListingPrice } from "../src/domain/price-evaluation";
import { buildResaleAssessment } from "../src/domain/resale-evaluate";
import type { Listing } from "../src/domain/types";

/** Deal Radar is ON by default; Scout/Telegram stay OFF unless explicitly enabled. */
const FLAGS = {
  resaleEvaluate: true,
  dealRadar: true,
  scout: false,
  telegram: true,
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

test("Scout stays hidden; Deal Radar and Telegram connect are available when default-on", async ({ page }) => {
  await mockFlags(page);
  await mockAccount(page, false);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.goto("/");
    const primaryNav = page.getByRole("navigation", { name: "Primary" });
    // Below 1400px the header keeps primary links in the menu (display:none until open).
    const openMenu = page.getByRole("button", { name: "Open menu" });
    if (await openMenu.isVisible()) await openMenu.click();
    await expect(primaryNav.getByRole("link", { name: "Resale" })).toBeVisible();
    await expect(primaryNav.getByRole("link", { name: "Deal Radar" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Scout" })).toHaveCount(0);
    expect(await scoutTelegramHrefs(page)).toEqual([]);
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/radar");
  // Page chrome (title) stays visible; watches still require verified sign-in.
  await expect(page.getByRole("heading", { name: "Deal Radar" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await expect(page.getByText(/not an anonymous browser cookie/i)).toBeVisible();

  await mockAccount(page, true);
  await page.route("**/api/radar/feed", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        demo: false,
        searches: [],
        alerts: [],
        lastRunAt: null,
        nextRunAt: null,
        intervalHours: 6,
        listingCounts: [],
        freeWatchLimit: 3,
        maxServPerSearch: 5,
        emailConfigured: false,
        emailNote: "Email alerts are not configured in this deployment. New matches appear on this page only.",
        activity: null,
      }),
    });
  });
  await page.goto("/radar");
  await expect(page.getByRole("heading", { name: "Deal Radar" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Not available" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /connect telegram/i })).toBeVisible();

  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "For AI agents" })).toBeVisible();
  expect(await scoutTelegramHrefs(page)).toEqual([]);
});

test("resale requires sign-in then SERV chat; charge copy stays honest", async ({ page }) => {
  await mockFlags(page);
  await mockAccount(page, false);
  await page.goto("/resale");
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await expect(page.locator("#resale-budget")).toHaveCount(0);
  await expect(page.getByLabel("Message")).toHaveCount(0);

  await mockAccount(page, true);
  await page.route("**/api/resale/chat", async (route) => {
    const body = route.request().postDataJSON() as { message?: string };
    const message = typeof body.message === "string" ? body.message : "flip under $12k";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        status: "done",
        sessionId: "e2e-resale-chat",
        messages: [
          { role: "user", content: message },
          { role: "assistant", content: "No listings cleared similar-listing economics inside this budget." },
        ],
        charged: true,
        balance: 2,
        result: {
          ok: true,
          best: null,
          alternatives: [],
          message: "No listings cleared similar-listing economics inside this budget.",
          creditNote: "1 report credit used for this delivered Resale verdict.",
          charged: true,
          balance: 2,
        },
      }),
    });
  });

  await page.goto("/resale");
  await expect(page.getByRole("heading", { name: "Resale" })).toBeVisible();
  await expect(page.getByText(/1 report credit/i).first()).toBeVisible();
  await expect(page.getByText(/nothing-fits|nothing fit|released/i).first()).toBeVisible();
  await expect(page.getByText(/not a profit guarantee/i).first()).toBeVisible();
  await expect(page.locator("#resale-budget")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Find flips/i })).toHaveCount(0);
  await expect(page.getByLabel("Message")).toBeVisible();

  await page.getByLabel("Message").fill("Looking for a flip under $12k that can clear $2k after light detail.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/No listings cleared similar-listing economics/i).first()).toBeVisible();
  await expect(page.getByText(/1 report credit used/i).first()).toBeVisible();
  await expect(page.getByRole("strong").filter({ hasText: /^Verdict: pass$/i })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
