import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scroll film frames", () => {
  it("ships a desktop sequence and a lighter phone sequence", () => {
    const desktop = readdirSync("public/frames/desktop").filter((name) => name.endsWith(".webp"));
    const mobile = readdirSync("public/frames/mobile").filter((name) => name.endsWith(".webp"));
    expect(desktop.length).toBe(48);
    expect(mobile.length).toBe(32);
    expect(mobile.length).toBeLessThan(desktop.length);
  });
});
