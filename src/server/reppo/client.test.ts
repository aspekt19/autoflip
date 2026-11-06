import { describe, expect, it, vi } from "vitest";
import { getReppoEvaluation, submitReppoEvaluation } from "./client";

describe("Reppo Evaluation API client", () => {
  it("submits a trace with server-side bearer auth and documented fields", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ evalId: "eval-123", status: "pending" }), { status: 202 }),
    );

    const result = await submitReppoEvaluation({
      apiKey: "test-secret",
      type: "trace",
      payload: "SERV explanation",
      context: "Evaluate factual grounding against supplied facts.",
      settlementMinutes: 10,
      fetch: fetchMock,
    });

    expect(result).toEqual({ evalId: "eval-123", status: "pending" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://eval.reppo.xyz/api/v1/agents/eval-requests/submit",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-secret" }),
        body: JSON.stringify({
          type: "trace",
          payload: "SERV explanation",
          context: "Evaluate factual grounding against supplied facts.",
          settlementMinutes: 10,
        }),
      }),
    );
  });

  it("retrieves an evaluation by its evalId", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ evalId: "eval-123", status: "settled" }), { status: 200 }),
    );

    await getReppoEvaluation({ apiKey: "test-secret", evalId: "eval-123", fetch: fetchMock });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://eval.reppo.xyz/api/v1/agents/eval-requests/eval-123",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects oversized payloads before making a request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      submitReppoEvaluation({ apiKey: "test-secret", type: "trace", payload: "x".repeat(50 * 1024 + 1), fetch: fetchMock }),
    ).rejects.toThrow("50 KB");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call the provider without an API key", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      submitReppoEvaluation({ apiKey: "", type: "trace", payload: "trace", fetch: fetchMock }),
    ).rejects.toThrow("REPPO_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
