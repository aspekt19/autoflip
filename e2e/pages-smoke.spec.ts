import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

/** Header + footer routes, plus account/auth pages the menu reaches. Scout is gone. */
const PAGES = [
  "/",
  "/find",
  "/check",
  "/resale",
  "/radar",
  "/reports",
  "/where-serv-runs",
  "/pricing",
  "/proof",
  "/credits",
  "/account",
  "/privacy",
  "/terms",
  "/login",
  "/login/finish",
  "/activity",
  "/report/sample",
];

/** Consumer pages. /developers is allowed to keep field names and protocol words. */
const CONSUMER = PAGES.filter((path) => path !== "/developers");

const JARGON =
  /\b(find_plan|free-gov|free_gov|vPIC|OpenServ|openserv|webhook|SCOUT_UI_ENABLED|SERV_API_KEY|Upstash|money-button|allowlisted|TypeScript|triage|sERV)\b|\bNHTSA\b|\bclamp\b/;

function trackConsole(page: Page) {
  const errors: string[] = [];
  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/favicon|Download the React DevTools/i.test(text)) return;
    errors.push(text);
  };
  const onPage = (err: Error) => errors.push(err.message);
  page.on("console", onConsole);
  page.on("pageerror", onPage);
  return errors;
}

test("every page renders, internal links resolve, and shopper copy stays plain", async ({ page }) => {
  const errors = trackConsole(page);
  const internal = new Set<string>();

  for (const path of PAGES) {
    const response = await page.goto(path, { waitUntil: "networkidle" });
    expect(response, path).toBeTruthy();
    expect(response!.status(), path).toBeLessThan(400);
    await expect(page.locator("h1").first()).toBeVisible();

    const found = await page.locator("a[href]").evaluateAll((anchors) =>
      anchors.map((anchor) => ({
        href: anchor.getAttribute("href") || "",
        text: (anchor.textContent || "").trim(),
      })),
    );
    for (const link of found) {
      if (!link.href || link.href.startsWith("mailto:") || link.href.startsWith("javascript:")) {
        throw new Error(`${path} has a dead link: ${link.text || link.href}`);
      }
      if (link.href.startsWith("#")) {
        const target = await page.locator(link.href).count();
        expect(target, `${path} missing ${link.href}`).toBeGreaterThan(0);
        continue;
      }
      let url: URL;
      try {
        url = new URL(link.href, page.url());
      } catch {
        throw new Error(`${path} has an unreadable link ${link.href}`);
      }
      if (url.origin !== new URL(page.url()).origin) continue;
      internal.add(`${url.pathname}${url.search}`);
    }

    if (CONSUMER.includes(path)) {
      const text = await page.locator("main").innerText();
      const hit = text.match(JARGON);
      expect(hit, `${path} shows jargon ${hit?.[0] ?? ""}`).toBeNull();
    }
  }

  expect(errors, errors.join("\n")).toEqual([]);

  for (const href of internal) {
    const response = await page.request.get(href);
    expect(response.status(), href).toBeLessThan(400);
  }
});

test("a missing page explains itself and the menu reaches Find", async ({ page }) => {
  const errors = trackConsole(page);
  const missing = await page.goto("/this-page-is-not-on-lemonless", { waitUntil: "networkidle" });
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "That page is not on Lemonless" })).toBeVisible();
  await page.goto("/pricing", { waitUntil: "networkidle" });
  await expect(async () => {
    if (!(await page.locator("nav.nav-open").count())) {
      await page.getByRole("button", { name: "Open menu" }).click();
    }
    await expect(page.locator("nav.nav-open")).toBeVisible();
  }).toPass();
  await page.locator("nav.nav-open").getByRole("link", { name: "Find a car" }).click();
  await expect(page).toHaveURL(/\/find$/);
  await expect(page.getByRole("heading", { name: "Chat with SERV" })).toBeVisible();
  const unexpected = errors.filter(
    (line) => !/this-page-is-not-on-lemonless|status of 404/i.test(line),
  );
  expect(unexpected, unexpected.join("\n")).toEqual([]);
});

test("verify and home actions do what they say", async ({ page }) => {
  await page.goto("/verify", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("Enter a report id.")).toBeVisible();

  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("radio", { name: "For resale" }).check();
  await expect(page.getByRole("link", { name: "Find flips" })).toBeVisible();
  await page.getByRole("radio", { name: "For me" }).check();
  const find = page.getByRole("button", { name: "Find cars" });
  await expect(find).toBeDisabled();
  await page.locator("#home-note").fill("SUV");
  await expect(find).toBeDisabled();
  await page.locator("#home-note").fill("A reliable SUV under $20,000 near Dallas");
  await expect(find).toBeEnabled();
});
