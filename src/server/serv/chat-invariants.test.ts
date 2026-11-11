import { describe, expect, it } from "vitest";
import {
  BASE_MODEL,
  SCHEMA_FALLBACK_MODEL,
  PROFILES,
  endpointForProfile,
  requestFor,
  streamForProfile,
} from "./index";

describe("SERV Gemini default + chat/non-stream invariants", () => {
  it("defaults BASE_MODEL to gemini-3.1-pro-preview with gpt-5.6-sol schema fallback", () => {
    expect(BASE_MODEL).toBe("gemini-3.1-pro-preview");
    expect(SCHEMA_FALLBACK_MODEL).toBe("gpt-5.6-sol");
  });

  it("Find/verdict/check steps POST chat/completions and stay non-stream when Shadow is on", () => {
    const ids = Object.keys(PROFILES).filter(
      (id) =>
        id.startsWith("find_") ||
        id === "verdict_decide" ||
        id === "verdict_challenge" ||
        id === "check_rules" ||
        id === "need_extract" ||
        id === "scout_plan",
    );
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      const entry = PROFILES[id as keyof typeof PROFILES];
      expect(endpointForProfile(entry)).toBe("chat");
      const req = requestFor(id as keyof typeof PROFILES, "{}");
      expect(req.endpoint).toBe("chat");
      expect(req.model).toContain(BASE_MODEL);
      if ((entry.tools as string[]).includes("shadow")) {
        expect(streamForProfile(entry)).toBe(false);
        expect(req.stream).toBe(false);
      }
    }
  });

  it("forces chat for any Gemini model even if a profile still lists responses", () => {
    const entry = { ...PROFILES.check_rules, endpoint: "responses" as const };
    expect(endpointForProfile(entry, "gemini-3.1-pro-preview")).toBe("chat");
    expect(endpointForProfile(entry, "gpt-5.6-sol")).toBe("chat");
  });
});
