import { describe, expect, it, vi } from "vitest";
import { BASE_MODEL, SCHEMA_FALLBACK_MODEL, requestFor, runServ } from "./index";
import { PROFILES } from "./profiles";

describe("SERV schema fallback + chat/non-stream invariants", () => {
  it("defaults BASE_MODEL to Gemini with Sol as SCHEMA_FALLBACK_MODEL", () => {
    expect(BASE_MODEL).toBe("gemini-3.1-pro-preview");
    expect(SCHEMA_FALLBACK_MODEL).toBe("gpt-5.6-sol");
  });

  it("resale/radar/agent product profiles request chat/completions and non-stream when shadow is on", () => {
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
      expect(req.endpoint).toBe("chat");
      const entry = PROFILES[id as keyof typeof PROFILES];
      if ((entry.tools as string[]).includes("shadow")) {
        expect(req.stream).toBe(false);
      }
    }
  });

  it("retries once with gpt-5.6-sol after Gemini content-null refusal schema failure", async () => {
    const models: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      models.push(String(body.model ?? ""));
      if (models.length === 1) {
        return Response.json({
          id: "gemini-fail",
          model: BASE_MODEL,
          choices: [
            {
              finish_reason: "stop",
              message: { content: null, refusal: "content_filter" },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      return Response.json({
        id: "sol-ok",
        model: SCHEMA_FALLBACK_MODEL,
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ ok: true }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    };

    const result = await runServ(
      "verdict_decide",
      { user: "{}" },
      { fetch: fetchImpl, apiKey: "test-key", model: BASE_MODEL },
    );
    expect(result.ok).toBe(true);
    expect(models[0]).toContain("gemini");
    expect(models[1]).toContain("gpt-5.6-sol");
    expect(result.schemaModelFallback).toEqual({
      from: BASE_MODEL,
      to: SCHEMA_FALLBACK_MODEL,
    });
    expect(result.httpAttempts).toBeGreaterThanOrEqual(2);
  });

  it("does not schema-fallback under experiment_single_attempt", async () => {
    const models: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      models.push(String(body.model ?? ""));
      return Response.json({
        id: "gemini-fail",
        model: BASE_MODEL,
        choices: [{ finish_reason: "stop", message: { content: null, refusal: "content_filter" } }],
      });
    };
    const result = await runServ(
      "verdict_decide",
      { user: "{}" },
      {
        fetch: fetchImpl,
        apiKey: "test-key",
        model: BASE_MODEL,
        transportPolicy: "experiment_single_attempt",
      },
    );
    expect(result.ok).toBe(false);
    expect(models).toHaveLength(1);
    expect(result.schemaModelFallback).toBeFalsy();
  });
});
