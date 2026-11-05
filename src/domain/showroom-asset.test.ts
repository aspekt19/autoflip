import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scroll film frames", () => {
  it("ships a desktop sequence and a lighter phone sequence", () => {
    const desktop = readdirSync("public/frames/desktop").filter((name) => name.endsWith(".webp"));
    const mobile = readdirSync("public/frames/mobile").filter((name) => name.endsWith(".webp"));
    expect(desktop.length).toBeGreaterThanOrEqual(60);
    expect(desktop.length).toBeLessThanOrEqual(120);
    expect(mobile.length).toBeGreaterThanOrEqual(48);
    expect(mobile.length).toBeLessThan(desktop.length);
  });
});
