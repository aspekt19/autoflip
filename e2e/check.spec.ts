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
  return {
    ok: true,
    kind,
    title: `${f.year.value} ${f.make.value} ${f.model.value}`,
    verdict: flags.some((flag) => flag.level === "stop") ? "walk_away" : "fair",
    verdictLabel: flags.some((flag) => flag.level === "stop") ? "Pass" : "Fair price",
    confidence: f.vin.value ? "Medium" : "Low",
    summary: `Fixture check for ${f.year.value} ${f.make.value} ${f.model.value}.`,
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
    questions: ["Ask for the out-the-door price, including dealer fees, and which fees are optional."],
    otd: null,
    otdNeedsZip: !f.zip.value,
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
    safetySummary: "Crash ratings skipped in Playwright fixture mode.",
    knownIssues: [{ text: "Fixture mode — free government live calls were not made.", source: "fixture" }],
    unknown: ["Paid vehicle history was not run"],
    listingsForVin: [],
    llmUsed: false,
    sample: true,
    usedFreeCheck: true,
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
  const payload = listingResultFromFixture("dealer-jsonld.html", "listing");
  await page.route("**/api/check", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  await page.goto("/check");
  const urlBox = page.getByRole("textbox", { name: "Listing link" });
  await expect(urlBox).toBeVisible();
  await expect(page.getByText("Who is this for")).toHaveCount(0);
  await urlBox.fill("https://dealer.example/inventory/camry-2021");
  await page.getByRole("button", { name: "Check this car" }).click();
  await expect(page.getByRole("heading", { name: "2021 Toyota Camry" })).toBeVisible();
  await expect(page.getByText("VIN: 4T1KZ1AK4MU060006", { exact: true })).toBeVisible();
  await expect(page.getByText(/\(JSON-LD\)/).first()).toBeVisible();
  await page.screenshot({ path: join(SCREEN_DIR, "check-listing-dealer.png"), fullPage: true });
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
          fields: null,
          provenance: [{ field: "vin", value: body.vin, source: "url" }],
          vin: body.vin,
          vinDecode: { year: 2017, make: "Honda", model: "Civic", errorCode: "0" },
          recalls: [],
          recallsAvailable: true,
          complaintCount: 12,
          fuel: { combMpg: 32, annualFuelCostUsd: 1600 },
          safetySummary: "NHTSA overall ratings skipped in fixture mode.",
          knownIssues: [{ text: "Fixture known-issue note.", source: "fixture" }],
          unknown: ["Paid vehicle history was not run", "Asking price (not provided on a VIN-only check)"],
          listingsForVin: [],
          llmUsed: false,
          sample: true,
          usedFreeCheck: true,
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
  await page.getByRole("textbox", { name: "17-character VIN" }).fill("1HGCM82633A004352");
  await page.getByRole("button", { name: "Build VIN dossier" }).click();
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
