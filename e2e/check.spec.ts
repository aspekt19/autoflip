import { expect, test, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseListingHtml } from "../src/domain/listing/parse-html";
import { listingRedFlags } from "../src/domain/listing/red-flags";

const SCREEN_DIR = join(process.cwd(), "docs/screenshots/check");
const FIXTURES = join(process.cwd(), "fixtures/listing-pages");

async function mockSignedIn(page: Page) {
  await page.route("**/api/account", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        email: "buyer@example.com",
        emailVerified: true,
        auth: { configured: true },
        credits: 2,
        freeChecks: {
          remaining: 3,
          limit: 3,
          resetsLabel: "1 December 2026 (00:00 UTC)",
        },
      }),
    });
  });
}

async function mockSignedOut(page: Page) {
  await page.route("**/api/account", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: false,
        auth: { configured: true },
        credits: 0,
        freeChecks: null,
      }),
    });
  });
}

function listingResultFromFixture(file: string, kind: "listing") {
  const html = readFileSync(join(FIXTURES, file), "utf8");
  const parsed = parseListingHtml(html, `https://fixture.example/${file}`);
  const f = parsed.deterministic;
  const flags = listingRedFlags({ fields: f, pageText: parsed.llmText });
  const sold = flags.some((flag) => flag.id === "sold");
  const stop = flags.some((flag) => flag.level === "stop");
  return {
    ok: true,
    kind,
    title: `${f.year.value} ${f.make.value} ${f.model.value}`,
    verdict: stop ? "walk_away" : "fair",
    verdictLabel: stop ? "Pass" : "Fair price",
    confidence: f.vin.value ? "Medium" : "Low",
    summary: sold
      ? `Fixture check for ${f.year.value} ${f.make.value} ${f.model.value}. This listing is marked SOLD.`
      : `Fixture check for ${f.year.value} ${f.make.value} ${f.model.value}.`,
    badge: f.priceUsd.value
      ? {
          label: "Fair price",
          tone: "fair",
          deltaUsd: 0,
          deltaLabel: "At the market price, based on 3 similar listings",
          fairValueUsd: f.priceUsd.value,
          sampleSize: 3,
          sampleNote: "Fixture comps",
        }
      : null,
    fairValueUsd: f.priceUsd.value,
    priceGap: 0,
    compCount: 3,
    compScope: "Fixture similar listings (no live paid calls)",
    redFlags: flags,
    questions: sold
      ? [
          "Confirm with the seller that this exact VIN is still for sale before planning a visit or deposit.",
          "Ask for the out-the-door price, including dealer fees, and which fees are optional.",
        ]
      : ["Ask for the out-the-door price, including dealer fees, and which fees are optional."],
    otd: null,
    otdNeedsZip: !f.zip.value && f.priceUsd.value != null,
    walkAwayUsd: f.priceUsd.value != null ? Math.round(f.priceUsd.value * 0.95) : null,
    walkAwayLabel:
      f.priceUsd.value != null ? `Walk-away price: $${Math.round(f.priceUsd.value * 0.95).toLocaleString("en-US")}.` : null,
    similarCars:
      f.priceUsd.value != null
        ? [
            {
              year: f.year.value ?? 2020,
              trim: f.trim.value,
              miles: f.miles.value ?? 40_000,
              askingUsd: f.priceUsd.value,
              adjustedUsd: f.priceUsd.value,
              reasons: ["Fixture adjustment"],
              sourceUrl: "https://dealer.example/vdp/fixture-comp",
            },
          ]
        : [],
    fields: f,
    provenance: Object.entries(f).map(([field, row]) => ({
      field,
      value: row.value,
      source: row.source,
    })),
    vin: f.vin.value,
    vinDecode: null,
    recalls: [],
    recallsAvailable: true,
    complaintCount: 0,
    fuel: null,
    fuelConflict: null,
    safetySummary: "Crash ratings skipped in Playwright fixture mode.",
    knownIssues: [{ text: "Fixture mode — free government live calls were not made.", source: "fixture" }],
    unknown: ["Paid vehicle history was not run"],
    listingsForVin: [],
    llmUsed: false,
    sample: true,
    usedFreeCheck: true,
    freeChecks: { remaining: 2, limit: 3, resetsLabel: "1 December 2026 (00:00 UTC)" },
  };
}

test.beforeAll(() => {
  mkdirSync(SCREEN_DIR, { recursive: true });
});

test("signed-out /check shows sign-in before any form fields", async ({ page }) => {
  await mockSignedOut(page);
  await page.goto("/check");
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await expect(page.getByLabel("Listing link")).toHaveCount(0);
  await page.screenshot({ path: join(SCREEN_DIR, "check-signed-out.png"), fullPage: true });
});

test("listing-link flow with dealer JSON-LD fixture (mocked API, no paid calls)", async ({ page }) => {
  await mockSignedIn(page);
  let accountRemaining = 3;
  await page.route("**/api/account", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        email: "buyer@example.com",
        emailVerified: true,
        auth: { configured: true },
        credits: 2,
        freeChecks: {
          remaining: accountRemaining,
          limit: 3,
          resetsLabel: "1 December 2026 (00:00 UTC)",
        },
      }),
    });
  });
  const payload = listingResultFromFixture("dealer-jsonld.html", "listing");
  await page.route("**/api/check", async (route) => {
    accountRemaining = 2;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...payload, freeChecks: { remaining: 2, limit: 3, resetsLabel: "1 December 2026 (00:00 UTC)" } }),
    });
  });

  await page.goto("/check");
  const urlBox = page.getByRole("textbox", { name: "Listing link" });
  await expect(urlBox).toBeVisible();
  await expect(page.getByText("Who is this for")).toHaveCount(0);
  await expect(page.getByText(/Free checks this month: 3 of 3 left/i)).toBeVisible();
  await urlBox.fill("https://dealer.example/inventory/camry-2021");
  await page.getByRole("button", { name: "Check this car" }).click();
  await expect(page.getByRole("heading", { name: "2021 Toyota Camry" })).toBeVisible();
  await expect(page.getByText("VIN: 4T1KZ1AK4MU060006", { exact: true })).toBeVisible();
  await expect(page.getByText(/\(JSON-LD\)/).first()).toBeVisible();
  await expect(page.getByText(/Walk-away/i).first()).toBeVisible();
  await expect(page.getByText(/Compared with 1 similar/i)).toBeVisible();
  await expect(page.getByText(/Free checks this month: 2 of 3 left/i)).toBeVisible();
  await page.screenshot({ path: join(SCREEN_DIR, "check-listing-dealer.png"), fullPage: true });
});

test("sold listing fixture shows stop warning and no soft no-red-flag copy", async ({ page }) => {
  await mockSignedIn(page);
  const payload = listingResultFromFixture("sold-schema-camry.html", "listing");
  await page.route("**/api/check", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  await page.goto("/check");
  await page.getByRole("textbox", { name: "Listing link" }).fill(
    "https://www.autoboutiquetexas.com/vehicle-details/used-2014-toyota-camry-le-4t1bf1fk0eu848445",
  );
  await page.getByRole("button", { name: "Check this car" }).click();
  await expect(page.getByRole("heading", { name: /2014 Toyota Camry/i })).toBeVisible();
  await expect(page.getByText(/marked SOLD/i).first()).toBeVisible();
  await expect(page.getByText(/No stop-level red flags/i)).toHaveCount(0);
  await expect(page.getByText(/FWD/i).first()).toBeVisible();
  await page.screenshot({ path: join(SCREEN_DIR, "check-listing-sold.png"), fullPage: true });
});

test("marketplace fixture paste path + VIN dossier screenshots", async ({ page }) => {
  await mockSignedIn(page);
  const listingPayload = listingResultFromFixture("marketplace-like.html", "listing");
  await page.route("**/api/check", async (route) => {
    const body = route.request().postDataJSON() as { kind?: string; vin?: string };
    if (body?.kind === "vin") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          kind: "vin_dossier",
          title: "2017 Honda Civic",
          verdict: "dossier",
          verdictLabel: "VIN dossier (free sources)",
          confidence: "Low",
          summary: "VIN dossier fixture for Playwright. No paid history report.",
          badge: null,
          fairValueUsd: null,
          priceGap: null,
          compCount: 0,
          compScope: "VIN dossier",
          redFlags: [],
          questions: ["Ask the dealer to run this VIN through NHTSA’s recall lookup before you pay."],
          otd: null,
          otdNeedsZip: false,
          walkAwayUsd: null,
          walkAwayLabel: null,
          similarCars: [],
          fields: null,
          provenance: [{ field: "vin", value: body.vin, source: "url" }],
          vin: body.vin,
          vinDecode: { year: 2017, make: "Honda", model: "Civic", errorCode: "0" },
          recalls: [],
          recallsAvailable: true,
          complaintCount: 12,
          fuel: { combMpg: 32, annualFuelCostUsd: 1600 },
          fuelConflict: null,
          safetySummary: "NHTSA overall ratings skipped in fixture mode.",
          knownIssues: [{ text: "Fixture known-issue note.", source: "fixture" }],
          unknown: ["Paid vehicle history was not run", "Asking price (not provided on a VIN-only check)"],
          listingsForVin: [],
          llmUsed: false,
          sample: true,
          usedFreeCheck: true,
          freeChecks: { remaining: 2, limit: 3, resetsLabel: "1 December 2026 (00:00 UTC)" },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(listingPayload),
    });
  });

  await page.goto("/check");
  await page.locator("label.pill", { hasText: "Paste listing text" }).click({ force: true });
  const html = readFileSync(join(FIXTURES, "marketplace-like.html"), "utf8");
  await page.getByRole("textbox", { name: "Listing text" }).fill(
    html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  );
  await page.getByRole("button", { name: "Check this car" }).click();
  await expect(page.getByRole("heading", { name: /2017 Honda Civic/i })).toBeVisible();
  await expect(page.getByText(/as is/i).first()).toBeVisible();
  await page.screenshot({ path: join(SCREEN_DIR, "check-listing-marketplace.png"), fullPage: true });

  await page.locator("label.pill", { hasText: "By VIN" }).click({ force: true });
  await expect(page.getByText(/Add a ZIP for the tax estimate/i)).toHaveCount(0);
  await page.getByRole("textbox", { name: "17-character VIN" }).fill("1HGCM82633A004352");
  await page.getByRole("button", { name: "Check this VIN" }).click();
  await expect(page.locator("p.kicker", { hasText: "VIN dossier" })).toBeVisible();
  await expect(page.getByText("1HGCM82633A004352").first()).toBeVisible();
  await page.screenshot({ path: join(SCREEN_DIR, "check-vin-dossier.png"), fullPage: true });
});

test("signed-out /find shows sign-in before the need form", async ({ page }) => {
  await mockSignedOut(page);
  await page.goto("/find");
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await expect(page.getByLabel(/note|What kind/i)).toHaveCount(0);
  await page.screenshot({ path: join(SCREEN_DIR, "find-signed-out.png"), fullPage: true });
});
