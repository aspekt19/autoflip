/**
 * Headless Chromium: scroll the homepage hero down then up and record painted frame indices.
 * Requires a running Next server (default http://127.0.0.1:3000) and google-chrome / Chromium.
 *
 *   node scripts/hero-scrub-scroll.mjs [baseUrl]
 *
 * Uses mouse wheel so Lenis + ScrollTrigger stay in sync (window.scrollTo alone drifts).
 */
import { createRequire } from "node:module";
import { accessSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const baseUrl = process.argv[2] || "http://127.0.0.1:3000";
const chromeCandidates = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/local/bin/google-chrome",
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

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900"],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
});

const page = await browser.newPage();
const painted = [];

await page.exposeFunction("__recordPainted", (frame, index) => {
  painted.push({ frame, index, t: Date.now() });
});

await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 120_000 });
await page.waitForFunction(() => Boolean(window.__filmScrubDebug), { timeout: 60_000 });
await page.waitForFunction(() => window.__filmScrubDebug?.isFullyDecoded() === true, {
  timeout: 120_000,
  polling: 200,
});

const start = await page.evaluate(() => ({
  index: window.__filmScrubDebug.getIndex(),
  painted: window.__filmScrubDebug.getPainted(),
  decoded: window.__filmScrubDebug.getDecodedCount(),
  full: window.__filmScrubDebug.isFullyDecoded(),
  y: window.scrollY,
}));

await page.evaluate(() => {
  const debug = window.__filmScrubDebug;
  if (!debug) return;
  let last = debug.getPainted();
  const tick = () => {
    const paintedNow = debug.getPainted();
    const indexNow = debug.getIndex();
    if (paintedNow !== last && paintedNow >= 0) {
      last = paintedNow;
      window.__recordPainted?.(paintedNow, indexNow);
    }
    window.__scrubProbeRaf = requestAnimationFrame(tick);
  };
  window.__scrubProbeRaf = requestAnimationFrame(tick);
});

await page.mouse.move(720, 400);

async function wheelBy(deltaY, steps, pauseMs) {
  for (let step = 0; step < steps; step += 1) {
    await page.mouse.wheel({ deltaY });
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  // Let Lenis lerp + ScrollTrigger scrub settle.
  await new Promise((resolve) => setTimeout(resolve, 900));
}

await wheelBy(140, 36, 40);
const mid = await page.evaluate(() => ({
  index: window.__filmScrubDebug.getIndex(),
  painted: window.__filmScrubDebug.getPainted(),
  decoded: window.__filmScrubDebug.getDecodedCount(),
  full: window.__filmScrubDebug.isFullyDecoded(),
  y: window.scrollY,
}));

await wheelBy(-140, 42, 40);
const end = await page.evaluate(() => ({
  index: window.__filmScrubDebug.getIndex(),
  painted: window.__filmScrubDebug.getPainted(),
  decoded: window.__filmScrubDebug.getDecodedCount(),
  full: window.__filmScrubDebug.isFullyDecoded(),
  y: window.scrollY,
}));

await page.evaluate(() => {
  if (window.__scrubProbeRaf) cancelAnimationFrame(window.__scrubProbeRaf);
});

// Snapshot near the last frame for sharpness artifact (scroll back down briefly).
await wheelBy(140, 36, 30);
await page.screenshot({
  path: "/opt/cursor/artifacts/hero-scrub-f048.png",
  clip: { x: 0, y: 0, width: 1440, height: 800 },
});

const frames = painted.map((row) => row.frame);
const unique = [...new Set(frames)];
const wentHigh = Math.max(...frames, 0);
const peakAt = frames.indexOf(wentHigh);
const afterPeak = peakAt >= 0 ? frames.slice(peakAt) : [];
const reverseMovedDown = afterPeak.length > 5 && afterPeak[afterPeak.length - 1] <= start.index + 1;
const exactWhenDecoded = painted.every((row) => row.frame === row.index);
const returnedToStart = Math.abs(end.index - start.index) <= 1 && Math.abs(end.painted - start.painted) <= 1;

const downThenUpOk =
  start.full &&
  mid.full &&
  end.full &&
  mid.index >= 45 &&
  mid.painted === mid.index &&
  wentHigh >= 40 &&
  reverseMovedDown &&
  returnedToStart &&
  exactWhenDecoded &&
  unique.length >= 20;

const report = {
  ok: downThenUpOk,
  chrome: chromePath,
  viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  start,
  midScroll: mid,
  endScroll: end,
  paintedSequenceSample: frames,
  paintedUniqueCount: unique.length,
  maxPainted: wentHigh,
  exactPaintedEqualsIndex: exactWhenDecoded,
  reverseReturnedToStart: returnedToStart,
  note:
    "After full decode, every painted frame must equal the scrub index both directions; reverse wheel must return near the start index.",
};

writeFileSync("/opt/cursor/artifacts/hero-scrub-scroll.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
process.exit(downThenUpOk ? 0 : 2);
