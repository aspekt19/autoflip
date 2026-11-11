/**
 * PR B — offline strict-schema checks for find_triage / find_decide / find_challenge.
 */
import { describe, expect, it } from "vitest";
import { PROFILES } from "./profiles";
import { assertEnumTypeReconciled, assertStrictJsonSchemaSubset } from "./strict-json-schema";

describe("PR B find decision profiles", () => {
  for (const id of ["find_triage", "find_decide", "find_challenge"] as const) {
    it(`${id} is strict-clean with no prompt_guard/shadow`, () => {
      const entry = PROFILES[id];
      expect(entry).toBeTruthy();
      expect(entry.tools).toEqual([]);
      const schema = entry.jsonSchema?.schema;
      expect(schema).toBeTruthy();
      expect(assertStrictJsonSchemaSubset(schema)).toEqual([]);
      expect(assertEnumTypeReconciled(schema)).toEqual([]);
    });
  }

  it("keeps prompt_guard on find_plan and listing_extract only among plan/extract/decide", () => {
    expect(PROFILES.find_plan.tools).toContain("prompt_guard");
    expect(PROFILES.listing_extract.tools).toContain("prompt_guard");
    expect(PROFILES.find_triage.tools).not.toContain("prompt_guard");
    expect(PROFILES.find_decide.tools).not.toContain("prompt_guard");
    expect(PROFILES.find_challenge.tools).not.toContain("prompt_guard");
  });
});
