/**
 * One source of truth: production SERV model id is only assigned in BASE_MODEL.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_MODEL } from "./profiles";

const SRC_ROOT = path.resolve(__dirname, "../..");
const PROFILES_REL = path.normalize("server/serv/profiles.ts");

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...filesUnder(full));
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) found.push(full);
  }
  return found;
}

describe("BASE_MODEL single source of truth", () => {
  it("BASE_MODEL is set (SERV_MODEL may override at call sites)", () => {
    expect(typeof BASE_MODEL).toBe("string");
    expect(BASE_MODEL.length).toBeGreaterThan(0);
    expect(BASE_MODEL).not.toContain(["gpt-6", ".1-sol"].join(""));
  });

  it("src has no quoted production model id outside the BASE_MODEL constant", () => {
    const literal = new RegExp(`(["'\`])${BASE_MODEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`, "g");
    const allowed = new RegExp(
      `export\\s+const\\s+BASE_MODEL\\s*=\\s*(["'])${BASE_MODEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`,
    );
    const hits: string[] = [];
    for (const file of filesUnder(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file);
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(literal)) {
        const idx = match.index ?? 0;
        const lineStart = text.lastIndexOf("\n", idx) + 1;
        const lineEnd = text.indexOf("\n", idx);
        const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        if (rel === PROFILES_REL && allowed.test(line)) continue;
        hits.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("src contains no leftover prior Sol production id", () => {
    const legacy = ["gpt-6", ".1-sol"].join("");
    const hits: string[] = [];
    for (const file of filesUnder(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file);
      const text = readFileSync(file, "utf8");
      if (text.includes(legacy)) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });
});
