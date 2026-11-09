import { expect, test } from "@playwright/test";

test("sample report shows a saved revision and an independent disagreement", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/report/sample");
  const trail = page.locator("details.agent-decision-trail");
  await expect(trail).toBeVisible();
  await expect(trail).toHaveAttribute("open", "");
  await expect(trail.getByText(/saved agent response revised the choice to negotiate/i)).toBeVisible();
  await expect(trail.getByText(/two newer comps arrived with lower asks/i).first()).toBeVisible();
  await expect(trail.getByText(/independent review disagreed/i).first()).toBeVisible();
  await expect(trail.getByText(/recall lookup was unavailable/i).first()).toBeVisible();
  await expect(trail.getByText(/no live spend/i)).toBeVisible();
  await expect(trail.getByText(/\$[0-9]/)).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("signed-out Check still hides the form", async ({ page }) => {
  await page.route("**/api/account", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ authenticated: false, auth: { configured: true }, credits: 0, freeChecks: null }),
    });
  });
  await page.goto("/check");
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /listing/i })).toHaveCount(0);
});
