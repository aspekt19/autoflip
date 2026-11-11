import { describe, expect, it, vi } from "vitest";
import { BASE_MODEL, SCHEMA_FALLBACK_MODEL, runServ, structuredTextMatchesSchema } from "./index";

describe("SERV schema-failure fallback", () => {
  it("structuredTextMatchesSchema requires JSON object with schema.required keys", () => {
    const schema = {
      type: "object",
      required: ["pickKey", "confidence"],
      properties: { pickKey: { type: "string" }, confidence: { type: "string" } },
    };
    expect(structuredTextMatchesSchema('{"pickKey":"a","confidence":"low"}', schema)).toBe(true);
    expect(structuredTextMatchesSchema('{"pickKey":"a"}', schema)).toBe(false);
    expect(structuredTextMatchesSchema("not-json", schema)).toBe(false);
  });

  it("retries once with SCHEMA_FALLBACK_MODEL when Gemini returns schema-invalid JSON", async () => {
    const models: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      models.push(String(body.model ?? ""));
      const isFallback = String(body.model ?? "").startsWith(SCHEMA_FALLBACK_MODEL);
      const content = isFallback
        ? JSON.stringify({
            pickKey: "k1",
            alternatives: [],
            action: "negotiate",
            confidence: "medium",
            note: "ok",
            reasons: ["price"],
            watchFor: ["inspect"],
            evidenceIds: ["e1"],
          })
        : JSON.stringify({ oops: true });
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await runServ(
      "find_pick",
      { user: "{}" },
      {
        apiKey: "test-key",
        fetch: fetchImpl as unknown as typeof fetch,
        model: BASE_MODEL,
        transportPolicy: "production",
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(models[0]).toContain(BASE_MODEL);
    expect(models.some((m) => m.startsWith(SCHEMA_FALLBACK_MODEL))).toBe(true);
    expect(result.httpAttempts).toBeGreaterThanOrEqual(2);
    expect(structuredTextMatchesSchema(result.text, {
      required: ["pickKey", "alternatives", "action", "confidence", "note", "reasons", "watchFor", "evidenceIds"],
    })).toBe(true);
  });

  it("does not schema-fallback under experiment_single_attempt", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ message: { role: "assistant", content: '{"oops":true}' }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await runServ(
      "find_pick",
      { user: "{}" },
      {
        apiKey: "test-key",
        fetch: fetchImpl as unknown as typeof fetch,
        model: BASE_MODEL,
        transportPolicy: "experiment_single_attempt",
      },
    );

    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
  });
});
