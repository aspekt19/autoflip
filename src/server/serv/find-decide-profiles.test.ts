/**
 * Offline strict-schema + capability checks for find_triage / find_decide / find_challenge.
 * Coordinated defaults for bc-b40c892e (see docs/openserv-reasoning-capabilities.md).
 */
import { describe, expect, it } from "vitest";
import { PROFILES } from "./profiles";
import { assertEnumTypeReconciled, assertStrictJsonSchemaSubset } from "./strict-json-schema";

describe("Find decision profiles (coordinated OpenServ defaults)", () => {
  it("find_triage is multipath + prompt_guard + strict schema (no shadow)", () => {
    const entry = PROFILES.find_triage;
    expect(entry.feature).toBe("multipath");
    expect(entry.tools).toEqual(["prompt_guard"]);
    expect(entry.endpoint).toBe("chat");
    expect(entry.stream).toBe(false);
    const schema = entry.jsonSchema?.schema;
    expect(schema).toBeTruthy();
    expect(assertStrictJsonSchemaSubset(schema)).toEqual([]);
    expect(assertEnumTypeReconciled(schema)).toEqual([]);
  });

  for (const id of ["find_decide", "find_challenge"] as const) {
    it(`${id} is multipath + prompt_guard + shadow + strict schema`, () => {
      const entry = PROFILES[id];
      expect(entry.feature).toBe("multipath");
      expect(entry.tools).toEqual(["prompt_guard", "shadow"]);
      expect(entry.shadowHint && entry.shadowHint.length).toBeGreaterThan(20);
      expect(entry.shadowMaxIterations).toBeGreaterThanOrEqual(1);
      expect(entry.endpoint).toBe("chat");
      expect(entry.stream).toBe(false);
      const schema = entry.jsonSchema?.schema;
      expect(schema).toBeTruthy();
      expect(assertStrictJsonSchemaSubset(schema)).toEqual([]);
      expect(assertEnumTypeReconciled(schema)).toEqual([]);
    });
  }

  it("keeps prompt_guard on find_plan and listing_extract alongside decide-path profiles", () => {
    expect(PROFILES.find_plan.tools).toContain("prompt_guard");
    expect(PROFILES.listing_extract.tools).toContain("prompt_guard");
    expect(PROFILES.find_triage.tools).toContain("prompt_guard");
    expect(PROFILES.find_decide.tools).toContain("prompt_guard");
    expect(PROFILES.find_challenge.tools).toContain("prompt_guard");
  });
});
