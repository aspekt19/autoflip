/**
 * verdict_challenge failures must log a concrete reason in the trail objection
 * (timeout / empty body / http), not a bare "did not finish".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputedReport } from "@/domain/types";

const runServ = vi.fn();

vi.mock("@/server/serv", () => ({
  runServ: (...args: unknown[]) => runServ(...args),
}));

import { runReportVerdictChallenge } from "./agent-second-pass";

function report(): ComputedReport {
  return {
    mode: "personal",
    subject: {
      vin: "2HGFC3B33KH356212",
      year: 2019,
      make: "Honda",
      model: "Civic",
      trim: "EX",
      miles: 17_480,
      priceUsd: 15_189,
      city: null,
      state: null,
      zip: null,
      dealer: null,
      vdp: null,
      primaryImage: null,
      carfaxUrl: null,
      used: true,
      cpo: null,
      accidentCount: null,
      oneOwner: null,
      ownerCount: null,
      usageType: null,
      fuel: null,
      engine: null,
      drivetrain: null,
      bodyStyle: null,
      latitude: null,
      longitude: null,
      removedAt: null,
      source: "autodev",
    },
    verdict: "negotiate",
    score: 0,
    reasons: ["Price is near fair value."],
    flags: [],
    questions: [],
    comps: [],
    compScope: "test",
    percentile: null,
    fairValueUsd: 15_000,
    fairRangeLowUsd: 14_500,
    fairRangeHighUsd: 15_500,
    fairConfidence: "reasonable",
    compMethodNote: "test",
    priceGap: 0.01,
    dataNotes: [],
    openParkIt: false,
    recallsAvailable: false,
    recalls: [],
    complaintCount: null,
  } as unknown as ComputedReport;
}

describe("runReportVerdictChallenge failure trail", () => {
  beforeEach(() => {
    runServ.mockReset();
  });

  it("logs empty-body / response-id reason when the second check does not finish", async () => {
    runServ.mockResolvedValue({
      ok: false,
      error: "SERV returned an empty explanation.",
      status: 200,
      proof: {
        latencyMs: 14_012,
        modelReported: "gpt-test",
        openserv: { id: "chatcmpl-7d34dd97-5ff2-4429-84e5-f6361a67fc73", usage: { total_tokens: 40 } },
      },
      fallback: "ignored_malformed",
      upstream: "empty_text",
      httpAttempts: 1,
      transportPolicy: "production",
      responseShape: null,
      failureDiag: { reasonCode: "empty_content", category: "empty_content" },
    });

    const { result } = await runReportVerdictChallenge({
      report: report(),
      primaryAction: "negotiate",
      confidence: "low",
      allowedActions: ["buy", "negotiate", "pass", "needs_inspection"],
      hasBudget: true,
      servKey: "test-key",
    });

    expect(result.status).toBe("unavailable");
    expect(result.objection).toMatch(/empty explanation/i);
    expect(result.objection).toMatch(/chatcmpl-7d34dd97-5ff2-4429-84e5-f6361a67fc73/);
    expect(result.objection).toMatch(/first verdict stands/i);
  });
});
