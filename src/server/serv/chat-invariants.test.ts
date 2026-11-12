import { describe, expect, it } from "vitest";
import { BASE_MODEL, requestFor } from "./index";
import { PROFILES } from "./profiles";

describe("SERV shared default + chat/non-stream invariants", () => {
  it("defaults BASE_MODEL to gpt-6.1-sol for all steps", () => {
    expect(BASE_MODEL).toBe("gpt-6.1-sol");
  });

  it("resale/radar/agent product profiles use responses for applicationTool, else chat", () => {
    const ids = Object.keys(PROFILES).filter(
      (id) =>
        id.startsWith("resale_") ||
        id.startsWith("radar_") ||
        id.startsWith("agent_") ||
        id.startsWith("flip_") ||
        id === "verdict_decide" ||
        id === "verdict_challenge" ||
        id === "check_rules" ||
        id === "personal_alert_review",
    );
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      const req = requestFor(id as keyof typeof PROFILES, "{}");
      const entry = PROFILES[id as keyof typeof PROFILES];
      // applicationTool must use /v1/responses with a real reasoning_effort (never chat+none).
      expect(req.endpoint).toBe(entry.applicationTool ? "responses" : "chat");
      expect(req.model).toContain(BASE_MODEL);
      if ((entry.tools as string[]).includes("shadow")) {
        expect(req.stream).toBe(false);
      }
    }
  });
});
