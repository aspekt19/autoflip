import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("e2e listing stub", () => {
  it("honours year, price, miles, distance, and make/model", () => {
    const script = path.join(process.cwd(), "scripts", "e2e-find-radar-stub-upstreams.mjs");
    const result = spawnSync(process.execPath, [script, "--self-test"], { encoding: "utf8" });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("stub self-test ok");
  });
});