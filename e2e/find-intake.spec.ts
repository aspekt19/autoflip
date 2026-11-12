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

/**
 * Confirm-entry / Continue calls /api/need for SERV parse — stub so e2e stays offline.
 * Thin boundary: do not invent budget/transmission/history from note regex; only echo
 * form-provided fields (and keep the note text).
 */
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
      typeof body.budgetUsd === "number" && Number.isFinite(body.budgetUsd) ? body.budgetUsd : null;
    const budgetKnown = body.budgetKnown === true && budgetUsd != null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        source: "form",
        guard: "not_configured",
        need: {
          mode: body.mode === "flip" ? "flip" : "personal",
          useCase: "unspecified",
          note: text,
          budgetUsd,
          budgetKnown,
          budgetScope: "car",
          mustHaves: [],
          priorities: [],
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
          transmission: null,
          fuelEconomyPriority: false,
          historyPreference: null,
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
          source: "form",
          responseId: null,
          label: "From your form",
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

test("home note opens Find at Budget — note carried, no code prefill", async ({ page }) => {
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

  // Thin boundary: note parsers are gone — land on Budget, never auto-Confirm.
  await expect(page.getByRole("heading", { name: /what i understood/i })).toHaveCount(0);
  await expect(page.locator(".progress .is-current")).toHaveText("Budget");
  await expect(page).toHaveURL(/note=/);
  const price = page.locator("#budget");
  await expect(price).toBeVisible();
  await expect(price).toHaveValue("");
  await expect(page.getByRole("checkbox", { name: /not sure yet/i })).toBeVisible();
  await expect(page.getByText("from your note")).toHaveCount(0);

  // Back reveals Need with the home note still in the textarea (stay offline — do not Continue).
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.locator("#need")).toBeVisible();
  await expect(page.locator("#need")).toHaveValue(NOTE);
  await page.getByRole("button", { name: "Back" }).click();
  // From Need, Back returns home; re-open so we stay on the Budget entry path.
  await page.locator("#home-note").fill(NOTE);
  await page.getByRole("button", { name: "Find cars" }).click();
  await expect(page).toHaveURL(/\/find\?/);
  await expect(page.locator(".progress .is-current")).toHaveText("Budget");

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

  // Form-owned budget → Confirm (SERV stub echoes form fields only).
  await page.setViewportSize({ width: 1280, height: 800 });
  await price.fill("15000");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: /what i understood/i })).toBeVisible();
  await expect(page.locator(".progress .is-current")).toHaveText("Confirm");
  await expect(page.getByLabel(/maximum vehicle price/i)).toHaveValue("15,000");
  // Code must not label form values as coming from the note.
  await expect(page.getByText("from your note")).toHaveCount(0);
  await expect(page.getByText(/you chose no year floor/i)).toHaveCount(0);

  const year = page.locator("#year-min-edit");
  await year.click();
  await year.pressSequentially("2016", { delay: 30 });
  await expect(year).toHaveValue("2016");
  await expect(page.getByText(/you chose no year floor/i)).toHaveCount(0);
  await year.fill("");
  await expect(year).toHaveValue("");
  await year.pressSequentially("2014", { delay: 30 });
  await expect(year).toHaveValue("2014");

  const priceOnConfirm = page.getByLabel(/maximum vehicle price/i);
  await priceOnConfirm.fill("18000");
  await expect(priceOnConfirm).toHaveValue("18000");
  await priceOnConfirm.fill("15,000");
  await expect(priceOnConfirm).toHaveValue("15,000");

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

  expect(blocked).toEqual([]);
});

test("note phrasings never skip Budget — code does not prefill from free text", async ({ page }) => {
  await mockSignedIn(page);
  await mockNeedParse(page);
  const cases = [
    "Looking for a reliable used car, budget around $15k.",
    "Looking for a reliable used car for 15,000 dollars.",
    "Looking for a reliable used car under 20 grand.",
    "Looking for a reliable used car around 12-15k.",
    "Looking for a reliable used car for errands.",
  ];
  for (const note of cases) {
    await openHomeNote(page, note);
    await expect(page.getByRole("heading", { name: /what i understood/i })).toHaveCount(0);
    await expect(page.locator(".progress .is-current")).toHaveText("Budget");
    await expect(page.locator("#budget")).toBeVisible();
    await expect(page.locator("#budget")).toHaveValue("");
    await expect(page.getByRole("checkbox", { name: /not sure yet/i })).toBeVisible();
    await expect(page.getByText("from your note")).toHaveCount(0);
  }
});
