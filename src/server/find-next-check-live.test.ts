import { describe, expect, it, vi } from "vitest";
import { runFindNextCheckLive } from "./find-next-check-live";
import { explicitNeedFromText } from "@/domain/need";

const baseNeed = explicitNeedFromText(
  "reliable Toyota not too old under 20k near 68114 within 50 miles",
  "personal",
);

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("runFindNextCheckLive seam (SERV choose → clamp → apply → research)", () => {
  it("SERV picks allowlisted widen_or_nationwide → apply mutates need → research true", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        id: "chatcmpl-find-next",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                checkId: "widen_or_nationwide",
                note: "Widen radius for empty inventory.",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    );

    const result = await runFindNextCheckLive(
      {
        need: baseNeed,
        listings: [], // empty → propose includes widen
        refine: {},
      },
      {
        servKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: { SERV_OUTPUT_TOKEN_MAX: "4096" },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("serv");
    expect(result.chosenId).toBe("widen_or_nationwide");
    expect(result.research).toBe(true);
    expect(result.replan.need.distanceMiles).toBeNull(); // nationwide
    expect(result.allowedChecks.some((c) => c.id === "widen_or_nationwide")).toBe(true);
    expect(result.honesty).toMatch(/allowlisted/i);
  });

  it("clamps unknown SERV checkId to deterministic allowlist — no invent", async () => {
    const result = await runFindNextCheckLive(
      {
        need: baseNeed,
        listings: [
          { make: "Toyota", model: "Camry", year: 2019, priceUsd: 15000, miles: 40000 },
          { make: "Toyota", model: "Corolla", year: 2018, priceUsd: 12000, miles: 50000 },
        ],
      },
      {
        servKey: "test-key",
        fetchImpl: (async () =>
          jsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({ checkId: "invent_best_car", note: "pick winner $999" }),
                },
              },
            ],
          })) as typeof fetch,
        env: {},
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("deterministic_fallback");
    expect(result.chosenId).not.toBe("invent_best_car" as never);
    expect(result.allowedChecks.map((c) => c.id)).not.toContain("invent_best_car");
  });

  it("without SERV key uses deterministic fallback (no network)", async () => {
    const fetchImpl = vi.fn();
    const result = await runFindNextCheckLive(
      { need: baseNeed, listings: [] },
      { servKey: null, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.source).toBe("deterministic_fallback");
    expect(result.chosenId).toBeTruthy();
  });

  it("records sanitized failureDiag on content-null refusal without raw leak", async () => {
    const refusal = "I won't help.";
    const result = await runFindNextCheckLive(
      { need: baseNeed, listings: [] },
      {
        servKey: "test-key",
        fetchImpl: (async () =>
          jsonResponse({
            choices: [{ finish_reason: "stop", message: { content: null, refusal } }],
            usage: { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 },
          })) as typeof fetch,
        env: {},
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("deterministic_fallback");
    expect(result.failureDiag?.category).toBe("content_null_refusal_field");
    expect(JSON.stringify(result)).not.toContain(refusal);
  });
});
