import { describe, expect, it } from "vitest";
import { BASE_MODEL, featuresUsedBy, modelFor, PROFILES } from "./profiles";

describe("modelFor kronos-multipath", () => {
  it("keeps production BASE_MODEL as gpt-6.1-sol", () => {
    expect(BASE_MODEL).toBe("gpt-6.1-sol");
  });

  it("appends -serv-kronos-multipath for plan/extract/next-check", () => {
    for (const id of ["need_extract", "find_plan", "find_next_check"] as const) {
      expect(PROFILES[id].feature).toBe("kronos-multipath");
      expect(modelFor(id)).toBe("gpt-6.1-sol-serv-kronos-multipath");
      expect(modelFor(id, "gpt-5.4-mini-serv-multipath")).toBe("gpt-5.4-mini-serv-kronos-multipath");
      const used = featuresUsedBy(id);
      expect(used).toEqual(expect.arrayContaining(["kronos", "multipath", "serv_prompt_guard"]));
    }
  });

  it("still supports single-feature suffixes", () => {
    expect(modelFor("flip_judge")).toBe("gpt-6.1-sol-serv-multipath");
    expect(modelFor("check_rules")).toBe("gpt-6.1-sol-serv-kronos");
  });

  it("wires decide-path and resale challenge with multipath", () => {
    for (const id of ["find_triage", "find_decide", "find_challenge", "resale_challenge"] as const) {
      expect(PROFILES[id].feature).toBe("multipath");
      expect(modelFor(id)).toBe("gpt-6.1-sol-serv-multipath");
    }
  });
});
