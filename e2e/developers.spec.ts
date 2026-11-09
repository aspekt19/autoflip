import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SCREEN_DIR = join(process.cwd(), "docs/screenshots/developers");

test.beforeAll(() => {
  mkdirSync(SCREEN_DIR, { recursive: true });
});

test("/developers shows Check/Find curl, MCP config, and OpenServ note", async ({ page }) => {
  await page.goto("/developers");
  await expect(page.getByRole("heading", { name: "For agents" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Check a car (curl)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Find cars (async)" })).toBeVisible();
  await expect(page.getByText(/OpenServ auth note/i)).toBeVisible();
  await expect(page.getByText(/Authorization: Bearer af_/i).first()).toBeVisible();
  await expect(page.locator("pre.doc").filter({ hasText: "mcpServers" })).toBeVisible();
  await expect(page.getByRole("link", { name: "/.well-known/agent.json" })).toBeVisible();
  await expect(page.getByRole("link", { name: "/llms.txt" })).toBeVisible();
  await expect(page.getByRole("link", { name: "/openapi.json" })).toBeVisible();
  await page.screenshot({ path: join(SCREEN_DIR, "developers-1280.png"), fullPage: true });
});

test("discovery files are public without sign-in", async ({ page }) => {
  const agent = await page.request.get("/.well-known/agent.json");
  expect(agent.ok()).toBeTruthy();
  const agentJson = await agent.json();
  expect(agentJson.tools.some((t: { name: string }) => t.name === "check_car")).toBe(true);
  expect(agentJson.tools.some((t: { name: string }) => t.name === "find_cars")).toBe(true);

  const llms = await page.request.get("/llms.txt");
  expect(llms.ok()).toBeTruthy();
  expect(await llms.text()).toMatch(/check_car/);

  const openapi = await page.request.get("/openapi.json");
  expect(openapi.ok()).toBeTruthy();
  const spec = await openapi.json();
  expect(spec.paths["/api/v1/check"]).toBeTruthy();
  expect(spec.paths["/api/v1/find"]).toBeTruthy();
});
