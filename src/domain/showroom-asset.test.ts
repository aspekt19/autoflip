import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("showroom model", () => {
  it("is a glTF under 5 MB", () => {
    const path = "public/models/showroom-suv.glb";
    const bytes = statSync(path).size;
    expect(bytes).toBeLessThan(5 * 1024 * 1024);
    expect(readFileSync(path).subarray(0, 4).toString()).toBe("glTF");
  });
});
