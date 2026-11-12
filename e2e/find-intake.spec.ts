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
          questions: [],
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
  await expect(page.locator("#budget")).toHaveCount(0);
});

test("home note opens Find chat — note carried, no form intake", async ({ page }) => {
  const blocked: string[] = [];
  const blockPaid = async (route: import("@playwright/test").Route) => {
    blocked.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort();
  };
  await page.route("**/api/scout", async (route) => {
    if (route.request().method() === "GET") {
      await route.continue();
      return;
    }
    await blockPaid(route);
  });
  await page.route("**/api/scout/**", blockPaid);
  await page.route(/\/api\/(match|report|stripe|credits|plans|serv)(\/|$|\?)/, blockPaid);
  // Do not hit live SERV chat in smoke — abort find chat turns.
  await page.route("**/api/find/chat", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        status: "ask",
        sessionId: "e2e-find-chat",
        messages: [
          { role: "user", content: NOTE },
          { role: "assistant", content: "Any must-have seats or AWD, or should I search with what you wrote?" },
        ],
        question: "Any must-have seats or AWD, or should I search with what you wrote?",
        charged: false,
      }),
    });
  });
  await mockSignedIn(page);

  await mkdir("docs/screenshots/intake", { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.locator("#home-note").fill(NOTE);
  await page.getByRole("button", { name: "Find cars" }).click();
  await expect(page).toHaveURL(/\/find\?/);
  await expect(page).toHaveURL(/note=/);
  await expect(page.getByRole("heading", { name: "Chat with SERV" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /what i understood/i })).toHaveCount(0);
  await expect(page.locator("#budget")).toHaveCount(0);
  await expect(page.locator(".progress .is-current")).toHaveCount(0);
  await expect(page.getByLabel("Message")).toBeVisible();
  await expect(page.getByText(NOTE).first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("main").screenshot({ path: "docs/screenshots/intake/find-chat-1280.png" });

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("main").screenshot({ path: "docs/screenshots/intake/find-chat-390.png" });

  expect(blocked).toEqual([]);
});

test("note phrasings open Find chat — code does not prefill form fields", async ({ page }) => {
  await mockSignedIn(page);
  await page.route("**/api/find/chat", async (route) => {
    const body = route.request().postDataJSON() as { message?: string };
    const message = typeof body.message === "string" ? body.message : "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        status: "ask",
        sessionId: "e2e-find-chat-phrases",
        messages: [
          { role: "user", content: message },
          { role: "assistant", content: "No other preferences — go ahead?" },
        ],
        question: "No other preferences — go ahead?",
        charged: false,
      }),
    });
  });
  const cases = [
    "Looking for a reliable used car, budget around $15k.",
    "Looking for a reliable used car for 15,000 dollars.",
    "Looking for a reliable used car under 20 grand.",
    "Looking for a reliable used car around 12-15k.",
    "Looking for a reliable used car for errands.",
  ];
  for (const note of cases) {
    await openHomeNote(page, note);
    await expect(page.getByRole("heading", { name: "Chat with SERV" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /what i understood/i })).toHaveCount(0);
    await expect(page.locator("#budget")).toHaveCount(0);
    await expect(page.locator(".progress .is-current")).toHaveCount(0);
    await expect(page.getByText("from your note")).toHaveCount(0);
  }
});
