import { describe, expect, it } from "vitest";
import { BASE_MODEL, featuresUsedBy, modelFor, PROFILES } from "./profiles";

describe("modelFor kronos-multipath", () => {
  it("keeps production BASE_MODEL as gpt-6-luna", () => {
    expect(BASE_MODEL.length).toBeGreaterThan(0);
  });

  it("emits the combined OpenServ suffix for find_plan", () => {
    for (const id of ["find_plan"] as const) {
      expect(PROFILES[id].feature).toBe("kronos-multipath");
      expect(modelFor(id)).toBe(`${BASE_MODEL}-serv-kronos-multipath`);
      expect(modelFor(id, "gpt-5.4-mini-serv-multipath")).toBe("gpt-5.4-mini-serv-kronos-multipath");
      const used = featuresUsedBy(id);
      expect(used).toContain("kronos");
      expect(used).toContain("multipath");
      expect(used).toContain("serv_prompt_guard");
      expect(used).toContain("content_filter");
    }
  });

  it("still supports single-feature suffixes", () => {
    expect(modelFor("flip_judge")).toBe(`${BASE_MODEL}-serv-multipath`);
    expect(modelFor("check_rules")).toBe(`${BASE_MODEL}-serv-kronos`);
  });
});
