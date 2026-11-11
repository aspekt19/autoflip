import { describe, expect, it } from "vitest";
import { BASE_MODEL, featuresUsedBy, modelFor, PROFILES } from "./profiles";

describe("modelFor kronos-multipath", () => {
  it("keeps production BASE_MODEL as gpt-5.4-mini", () => {
    expect(BASE_MODEL).toBe("gpt-5.4-mini");
  });

  it("emits the combined OpenServ suffix for find_plan / need_extract / find_next_check", () => {
    for (const id of ["find_plan", "need_extract", "find_next_check"] as const) {
      expect(PROFILES[id].feature).toBe("kronos-multipath");
      expect(modelFor(id)).toBe("gpt-5.4-mini-serv-kronos-multipath");
      expect(modelFor(id, "gpt-5.6-sol-serv-multipath")).toBe("gpt-5.6-sol-serv-kronos-multipath");
      const used = featuresUsedBy(id);
      expect(used).toContain("kronos");
      expect(used).toContain("multipath");
      expect(used).toContain("serv_prompt_guard");
      expect(used).toContain("content_filter");
    }
  });

  it("still supports single-feature suffixes", () => {
    expect(modelFor("flip_judge")).toBe("gpt-5.4-mini-serv-multipath");
    expect(modelFor("check_rules")).toBe("gpt-5.4-mini-serv-kronos");
  });
});
