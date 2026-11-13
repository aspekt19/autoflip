import { expect, test } from "@playwright/test";

test("stale sample report is gone and the home page does not link to it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const sample = await page.goto("/report/sample");
  expect(sample?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "That page is not on Lemonless" })).toBeVisible();
  // Invented sample copy must not ship as a live report.
  await expect(page.getByText(/saved agent response revised/i)).toHaveCount(0);
  await expect(page.getByText(/two newer comps arrived with lower asks/i)).toHaveCount(0);
  await expect(page.getByText("$33,699")).toHaveCount(0);
  await expect(page.getByText("$34,374")).toHaveCount(0);

  await page.goto("/");
  await expect(page.getByRole("link", { name: /see a sample report/i })).toHaveCount(0);
});

test("signed-out Check still hides the form", async ({ page }) => {
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
  await page.goto("/check");
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /listing/i })).toHaveCount(0);
});
