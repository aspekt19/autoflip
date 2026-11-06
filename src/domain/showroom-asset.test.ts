import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scroll film frames", () => {
  it("ships 2560 and 4K desktop sequences and a lighter phone sequence", () => {
    const desktop2560 = readdirSync("public/frames/desktop-2560").filter((name) => name.endsWith(".webp"));
    const desktop4k = readdirSync("public/frames/desktop-4k").filter((name) => name.endsWith(".webp"));
    const mobile = readdirSync("public/frames/mobile").filter((name) => name.endsWith(".webp"));
    expect(desktop2560.length).toBe(48);
    expect(desktop4k.length).toBe(48);
    expect(mobile.length).toBe(32);
    expect(mobile.length).toBeLessThan(desktop2560.length);
  });
});
