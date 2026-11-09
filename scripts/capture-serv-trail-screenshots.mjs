/**
 * Capture How-the-agent-decided surfaces (sample report + home). No paid calls.
 *
 *   node scripts/capture-serv-trail-screenshots.mjs [baseUrl]
 */
import { createRequire } from "node:module";
import { accessSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const baseUrl = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/$/, "");
const outDir = join(process.cwd(), "docs/screenshots/serv-trail");
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
  { path: "/report/sample", name: "sample-report" },
  { path: "/check", name: "check" },
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
    // Expand the trail panel when present.
    await page.evaluate(() => {
      const trail = document.querySelector("details.agent-decision-trail");
      if (trail) trail.open = true;
    });
    const file = join(outDir, `${target.name}-${width}.jpeg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 82, fullPage: true });
    console.log("wrote", file);
  }
  await page.close();
}

await browser.close();
