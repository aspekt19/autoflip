import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const NOTE =
  "Looking for a reliable used car for myself, budget around $15k, automatic, good on gas, nothing salvage or with accident history.";

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
        freeChecks: { remaining: 3, limit: 3, resetsLabel: "1 December 2026 (00:00 UTC)" },
      }),
    });
  });
}

function budgetUsdFromNote(text: string): number | null {
  const rangeK = text.match(/(\d{1,3})\s*-\s*(\d{1,3})\s*k\b/i);
  if (rangeK) return Number(rangeK[2]) * 1000;
  const k = text.match(/(?:\$|budget|around|under|for)\s*\$?\s*(\d{1,3})\s*k\b/i);
  if (k) return Number(k[1]) * 1000;
  const grand = text.match(/(\d{1,3})\s*grand\b/i);
  if (grand) return Number(grand[1]) * 1000;
  const dollars = text.match(/for\s+(\d{1,3}(?:,\d{3})*)\s*dollars/i);
  if (dollars) return Number(dollars[1].replace(/,/g, ""));
  const cash = text.match(/\$\s*(\d{1,3}(?:,\d{3})*)\b/);
  if (cash) return Number(cash[1].replace(/,/g, ""));
  return null;
}

/** Confirm-entry notes always call /api/need for SERV parse — stub so e2e stays offline. */
async function mockNeedParse(page: Page) {
  await page.route("**/api/need", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON() as {
      text?: string;
      mode?: "personal" | "flip";
      budgetUsd?: number | null;
      budgetKnown?: boolean;
      zip?: string | null;
      distanceMiles?: number | null;
    };
    const text = typeof body.text === "string" ? body.text : "";
    const budgetUsd =
      typeof body.budgetUsd === "number" && Number.isFinite(body.budgetUsd)
        ? body.budgetUsd
        : budgetUsdFromNote(text);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        source: "form",
        guard: "not_configured",
        need: {
          mode: body.mode === "flip" ? "flip" : "personal",
          useCase: /family|myself|errands|commute/i.test(text) ? "commute" : "unspecified",
          note: text,
          budgetUsd,
          budgetKnown: budgetUsd != null,
          budgetScope: "car",
          mustHaves: [],
          priorities: /gas|fuel/i.test(text) ? ["fuel economy"] : [],
          zip: body.zip ?? null,
          distanceMiles: body.distanceMiles ?? null,
          repairAbility: "unknown",
          targetProfitUsd: null,
          milesMax: null,
          yearMin: null,
          yearMax: null,
          yearBandResolved: false,
          milesCapResolved: false,
          conditionPriority: "unspecified",
          make: null,
          preferredMakes: [],
          preferredModels: [],
          preferredModelsSource: "none",
          openToOtherMakes: true,
          bodyStyle: null,
          transmission: /automatic/i.test(text) ? "automatic" : null,
          fuelEconomyPriority: /gas|fuel/i.test(text),
          historyPreference: /salvage|accident/i.test(text) ? "no_salvage_no_accidents" : null,
          locationPhrase: null,
        },
        followUps: [],
        findPlan: {
          summary: text.trim() || "Car shopping request.",
          bodyStyles: ["any"],
          budget: { maxUsd: budgetUsd, approximate: false, quote: null },
          yearMin: null,
          yearMax: null,
          milesMax: null,
          drivetrain: { value: "any", strength: "none", quote: null },
          fuel: { value: "any", strength: "none", quote: null },
          seatsMin: null,
          location: { zip: body.zip ?? null, phrase: null, needsZip: false },
          priorities: [],
          namedModels: [],
          excludedMakes: [],
          question: { id: "none", text: null },
          directions: [
            {
              label: "Cars in budget",
              why: "Offline fallback search by budget.",
              bodyStyle: "any",
              models: [],
            },
          ],
        },
        directions: [
          {
            id: "cars-in-budget",
            segment: "Cars in budget",
            why: "Offline fallback search by budget.",
            guidance: "editorial",
            yearMin: 2012,
            yearMax: 2020,
            yearBecause: "No budget was given, so this is only a starting year band.",
            models: [],
            search: { make: "", model: "" },
          },
        ],
        checks: [
          {
            purpose: "find_plan",
            tools: ["serv_prompt_guard"],
            features: [],
            promptGuard: "not_configured",
            shadowOutcome: "not_used",
            shadowMaxIterations: null,
            latencyMs: 0,
          },
        ],
        criteriaParse: {
          source: "code",
          responseId: null,
          label: "Parsed by code",
        },
      }),
    });
  });
}

async function openHomeNote(page: Page, note: string) {
  await page.goto("/");
  await page.locator("#home-note").fill(note);
  await page.getByRole("button", { name: "Find cars" }).click();
  await expect(page).toHaveURL(/\/find\?/);
}

test("signed-out Find shows sign-in before the form", async ({ page }) => {
  await page.route("**/api/account", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ authenticated: false, auth: { configured: true }, credits: 0, freeChecks: null }),
    });
  });
  await page.goto("/find?note=Looking%20for%20a%20reliable%20car%20around%20%2415k&mode=personal");
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await expect(page.getByLabel(/maximum vehicle price/i)).toHaveCount(0);
  await expect(page.locator("#need")).toHaveCount(0);
});

test("home note opens Find confirm with the note prefilled", async ({ page }) => {
  const blocked: string[] = [];
  const blockPaid = async (route: import("@playwright/test").Route) => {
    blocked.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort();
  };
  // GET /api/scout is the header capability check. Starting a Scout run is not part of this flow.
  await page.route("**/api/scout", async (route) => {
    if (route.request().method() === "GET") {
      await route.continue();
      return;
    }
    await blockPaid(route);
  });
  await page.route("**/api/scout/**", blockPaid);
  await page.route(/\/api\/(match|report|stripe|credits|plans|serv)(\/|$|\?)/, blockPaid);
  await mockSignedIn(page);
  await mockNeedParse(page);

  await mkdir("docs/screenshots/intake", { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.locator("#home-note").fill(NOTE);
  await page.getByRole("button", { name: "Find cars" }).click();
  await expect(page).toHaveURL(/\/find\?/);
  await expect(page).toHaveURL(/home-mode=on/);
  await expect(page).toHaveURL(/mode=personal/);
  await expect(page.getByRole("heading", { name: /what i understood/i })).toBeVisible();
  await expect(page.locator(".progress .is-current")).toHaveText("Confirm");
  await expect(page.getByLabel(/maximum vehicle price/i)).toHaveValue("15,000");
  await expect(page.getByLabel("Transmission")).toHaveValue("automatic");
  await expect(page.getByLabel("History")).toHaveValue("no_salvage_no_accidents");
  await expect(page.getByRole("checkbox", { name: /fuel economy/i })).toBeChecked();
  await expect(page.getByText("from your note").first()).toBeVisible();
  await expect(page.getByText(/you chose no year floor/i)).toHaveCount(0);
  await expect(page.getByLabel(/maximum vehicle price/i)).toBeVisible();

  const year = page.locator("#year-min-edit");
  await year.click();
  await year.pressSequentially("2016", { delay: 30 });
  await expect(year).toHaveValue("2016");
  await expect(page.getByText(/you chose no year floor/i)).toHaveCount(0);
  await year.fill("");
  await expect(year).toHaveValue("");
  await expect(page.getByText(/you chose no year floor/i)).toHaveCount(0);
  await year.pressSequentially("2014", { delay: 30 });
  await expect(year).toHaveValue("2014");

  const priceOnConfirm = page.getByLabel(/maximum vehicle price/i);
  await priceOnConfirm.fill("18000");
  await expect(priceOnConfirm).toHaveValue("18000");
  await priceOnConfirm.fill("15,000");
  await expect(priceOnConfirm).toHaveValue("15,000");
  await expect(page.getByText("from your note").first()).toBeVisible();

  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>(".bar, .skip").forEach((el) => {
      el.style.position = "static";
      el.style.transform = "none";
    });
    window.scrollTo(0, 0);
  });
  await page.locator("main").screenshot({ path: "docs/screenshots/intake/confirm-1280.png" });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(year).toHaveValue("2014");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("main").screenshot({ path: "docs/screenshots/intake/confirm-390.png" });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Back" }).click();
  const price = page.locator("#budget");
  await expect(price).toBeVisible();
  await expect(price).toHaveValue("15,000");
  const check = page.locator("label.check-line");
  await expect(check).toBeVisible();
  const priceBox = await price.boundingBox();
  const checkBox = await check.boundingBox();
  const inputBox = await page.locator("label.check-line input").boundingBox();
  expect(priceBox).toBeTruthy();
  expect(checkBox).toBeTruthy();
  expect(inputBox).toBeTruthy();
  expect(checkBox!.y).toBeGreaterThanOrEqual(priceBox!.y + priceBox!.height - 1);
  expect(inputBox!.y).toBeGreaterThanOrEqual(priceBox!.y + priceBox!.height - 1);
  expect(inputBox!.width).toBeGreaterThan(14);
  expect(inputBox!.height).toBeGreaterThan(14);
  expect(Math.abs(checkBox!.x - priceBox!.x)).toBeLessThan(16);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("main").screenshot({ path: "docs/screenshots/intake/budget-not-sure-1280.png" });

  await page.setViewportSize({ width: 390, height: 844 });
  const priceNarrow = await price.boundingBox();
  const checkNarrow = await check.boundingBox();
  expect(checkNarrow!.y).toBeGreaterThanOrEqual(priceNarrow!.y + priceNarrow!.height - 1);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("main").screenshot({ path: "docs/screenshots/intake/budget-not-sure-390.png" });

  expect(blocked).toEqual([]);
});

test("note phrasings prefill a budget or leave the price step when none was written", async ({ page }) => {
  await mockSignedIn(page);
  await mockNeedParse(page);
  const cases: Array<{ note: string; price: string | null }> = [
    { note: "Looking for a reliable used car, budget around $15k.", price: "15,000" },
    { note: "Looking for a reliable used car for 15,000 dollars.", price: "15,000" },
    { note: "Looking for a reliable used car under 20 grand.", price: "20,000" },
    { note: "Looking for a reliable used car around 12-15k.", price: "15,000" },
    { note: "Looking for a reliable used car for errands.", price: null },
  ];
  for (const item of cases) {
    await openHomeNote(page, item.note);
    if (item.price == null) {
      await expect(page.getByRole("heading", { name: /what i understood/i })).toHaveCount(0);
      await expect(page.locator("#budget")).toBeVisible();
      await expect(page.getByRole("checkbox", { name: /not sure yet/i })).toBeVisible();
      continue;
    }
    await expect(page.getByRole("heading", { name: /what i understood/i })).toBeVisible();
    await expect(page.locator(".progress .is-current")).toHaveText("Confirm");
    await expect(page.getByLabel(/maximum vehicle price/i)).toHaveValue(item.price);
    await expect(page.getByText("from your note").first()).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /not sure yet/i })).toHaveCount(0);
    await expect(page.getByText(/oldest model year you will consider/i)).toHaveCount(0);
  }
});
