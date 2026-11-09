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
  await page.route(/\/api\/(match|need|report|stripe|credits|plans|serv)(\/|$|\?)/, blockPaid);
  await mockSignedIn(page);

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
