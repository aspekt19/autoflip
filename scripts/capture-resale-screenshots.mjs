/**
 * Capture honest-resale surface screenshots (no paid Autodev calls).
 * Requires a running Next server and Chrome.
 *
 *   node scripts/capture-resale-screenshots.mjs [baseUrl]
 */
import { createRequire } from "node:module";
import { accessSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const baseUrl = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/$/, "");
const outDir = join(process.cwd(), "docs/screenshots/resale");
mkdirSync(outDir, { recursive: true });

const chromeCandidates = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/local/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const chromePath = chromeCandidates.find((path) => {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
});

if (!chromePath) {
  console.error("No Chrome binary found. Set CHROME_PATH.");
  process.exit(1);
}

const widths = [390, 1280, 1920];
const pages = [
  { path: "/resale", name: "resale" },
  { path: "/radar", name: "radar-gated" },
  { path: "/", name: "home" },
];

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

for (const width of widths) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: width < 800 ? 844 : 900, deviceScaleFactor: 1 });
  for (const target of pages) {
    await page.goto(`${baseUrl}${target.path}`, { waitUntil: "networkidle2", timeout: 120_000 });
    const file = join(outDir, `${target.name}-${width}.jpeg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 82, fullPage: true });
    console.log("wrote", file);
  }
  await page.close();
}

await browser.close();
