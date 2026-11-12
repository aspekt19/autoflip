/**
 * Vercel Hobby: Serverless Functions must have maxDuration between 1 and 300.
 * Scans every App Router route.ts and fails if any export exceeds 300.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Scan all App Router routes under src/app (not only api/). */
const APP_ROOT = path.resolve(__dirname, "..");
const HOBBY_MAX_DURATION = 300;

function walkRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkRouteFiles(full));
      continue;
    }
    if (name === "route.ts") out.push(full);
  }
  return out;
}

function exportedMaxDuration(src: string): number | null {
  const match = src.match(/export\s+const\s+maxDuration\s*=\s*(\d+)\s*;/);
  if (!match) return null;
  return Number(match[1]);
}

describe("Vercel Hobby maxDuration", () => {
  it(`keeps every src/app/**/route.ts maxDuration between 1 and ${HOBBY_MAX_DURATION}`, () => {
    const routes = walkRouteFiles(APP_ROOT);
    expect(routes.length).toBeGreaterThan(10);

    const violations: Array<{ file: string; maxDuration: number }> = [];
    const missing: string[] = [];

    for (const file of routes) {
      const src = readFileSync(file, "utf8");
      const value = exportedMaxDuration(src);
      if (value == null) {
        // Routes without an export inherit the platform default (safe for Hobby).
        continue;
      }
      if (!Number.isFinite(value) || value < 1 || value > HOBBY_MAX_DURATION) {
        violations.push({
          file: path.relative(path.resolve(APP_ROOT, "../.."), file),
          maxDuration: value,
        });
      }
      if (value == null) missing.push(file);
    }

    expect(violations).toEqual([]);
    void missing;
  });
});
