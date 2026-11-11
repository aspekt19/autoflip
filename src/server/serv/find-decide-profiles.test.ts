import { describe, expect, it } from "vitest";
import { PROFILES } from "./src/server/serv/profiles";
import { assertStrictJsonSchemaSubset, assertEnumTypeReconciled } from "./src/server/serv/strict-json-schema";

describe("PR B find decision schemas", () => {
  for (const id of ["find_triage", "find_decide", "find_challenge"] as const) {
    it(`${id} is strict-clean and has no prompt_guard/shadow`, () => {
      const entry = PROFILES[id];
      expect(entry.tools).toEqual([]);
      const schema = entry.jsonSchema?.schema;
      expect(schema).toBeTruthy();
      expect(assertStrictJsonSchemaSubset(schema)).toEqual([]);
      expect(assertEnumTypeReconciled(schema)).toEqual([]);
    });
  }
});
