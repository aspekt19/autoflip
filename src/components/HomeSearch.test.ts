import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("HomeSearch Find cars navigation", () => {
  it("uses native GET to /find so submit works without client soft-nav", () => {
    const source = readFileSync(join(__dirname, "HomeSearch.tsx"), "utf8");
    expect(source).toMatch(/["']\/find["']/);
    expect(source).toMatch(/method=["']get["']/);
    expect(source).toMatch(/name=["']note["']/);
    expect(source).toMatch(/name=["']mode["']/);
    // Soft-nav-only path was the production failure mode after preventDefault.
    expect(source).not.toMatch(/router\.push/);
    expect(source).not.toMatch(/preventDefault\(\);\s*\n\s*const text/);
  });

  it("routes For resale to the minimal /resale estimate instead of Find", () => {
    const source = readFileSync(join(__dirname, "HomeSearch.tsx"), "utf8");
    expect(source).toMatch(/href=["']\/resale["']/);
    expect(source).toMatch(/Estimate resale/);
    expect(source).toMatch(/not a\s+profit guarantee/i);
  });
});
