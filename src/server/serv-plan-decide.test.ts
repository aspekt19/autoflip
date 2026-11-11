import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyRadarFlipProfitGuardrail,
  decideCandidates,
  installServPlanDecidePorts,
  isProfitablePickCandidate,
  planSearch,
  resetServPlanDecidePorts,
} from "./serv-plan-decide";
import { emptyResaleJournal } from "@/domain/resale-decision-journal";
import { makeResaleDeadline } from "@/domain/resale-deadline";

afterEach(() => {
  resetServPlanDecidePorts();
});

describe("serv-plan-decide façade", () => {
  it("never treats negative mid profit as a pick candidate", () => {
    expect(isProfitablePickCandidate({ profitMidUsd: 1200 })).toBe(true);
    expect(isProfitablePickCandidate({ profitMidUsd: 0 })).toBe(true);
    expect(isProfitablePickCandidate({ profitMidUsd: -1 })).toBe(false);
    expect(isProfitablePickCandidate({ rankingProfitMidUsd: -50, profitMidUsd: 900 })).toBe(false);
    expect(isProfitablePickCandidate({ profitMidUsd: null })).toBe(false);
  });

  it("blocks Radar flip alerts when expected mid profit is negative", () => {
    const decisions = new Map([
      ["VINPOS00000000001", { verdict: "alert" as const, note: "Looks good." }],
      ["VINNEG00000000001", { verdict: "alert" as const, note: "SERV said alert." }],
    ]);
    const guarded = applyRadarFlipProfitGuardrail(decisions, [
      { vin: "VINPOS00000000001", profitMidUsd: 1_800 },
      { vin: "VINNEG00000000001", profitMidUsd: -400 },
    ]);
    expect(guarded.decisions?.get("VINPOS00000000001")?.verdict).toBe("alert");
    expect(guarded.decisions?.get("VINNEG00000000001")?.verdict).toBe("skip");
    expect(guarded.blockedNegativeProfit).toEqual(["VINNEG00000000001"]);
  });

  it("routes planSearch through the injectable PR A port", async () => {
    const planResale = vi.fn(async () => ({
      directionIds: ["dir-a"],
      journal: emptyResaleJournal(),
      proofRecords: [],
      source: "serv" as const,
    }));
    installServPlanDecidePorts({ planResale });
    const deadline = makeResaleDeadline(60_000);
    const out = await planSearch({
      surface: "resale",
      budgetUsd: 12_000,
      allowedDirections: [
        { id: "dir-a", segment: "Compacts", make: "Toyota", model: "Corolla" },
        { id: "dir-b", segment: "Crossovers", make: "Honda", model: "CR-V" },
      ],
      journal: emptyResaleJournal(),
      recordedAt: new Date().toISOString(),
      deadline,
    });
    expect(planResale).toHaveBeenCalledOnce();
    expect(out.directionIds).toEqual(["dir-a"]);
    expect(out.source).toBe("serv");
  });

  it("routes decideCandidates(resale) through the injectable PR B port", async () => {
    const { emptyAgentVerdict } = await import("@/domain/agent-verdict-schema");
    const agentVerdict = emptyAgentVerdict({
      verdict: "pass",
      confidence: "low",
      no_serv_step: true,
    });
    const decideResale = vi.fn(async () => ({
      best: null,
      alternatives: [],
      agentVerdict,
      journal: emptyResaleJournal(),
      trace: null,
      proofRecords: [],
      verdictAction: "pass" as const,
      confidence: "Low" as const,
      ranJudge: false,
      ranDecide: false,
      checkpoint: {
        phaseCompleted: "empty" as const,
        journal: emptyResaleJournal(),
        rankedAll: [],
        ordered: [],
        shortlist: [],
        best: null,
        alternatives: [],
        verdictAction: "pass" as const,
        confidence: "Low" as const,
        agentVerdict,
        trail: [],
        secondPass: agentVerdict.second_pass ?? {
          status: "not_run" as const,
          action: null,
          objection: "stub",
          evidenceIds: [],
          confidenceBefore: null,
          confidenceAfter: null,
        },
        agentConfidence: "low" as const,
        ranJudge: false,
        ranDecide: false,
        trace: null,
        proofRecords: [],
        budgetUsd: 10_000,
        timeToSellPref: undefined,
      },
    }));
    installServPlanDecidePorts({ decideResale });
    const out = await decideCandidates({
      surface: "resale",
      candidates: [],
      budgetUsd: 10_000,
    });
    expect(decideResale).toHaveBeenCalledOnce();
    expect(out.surface).toBe("resale");
    if (out.surface === "resale") {
      expect(out.result.verdictAction).toBe("pass");
      expect(out.result.best).toBeNull();
    }
  });

  it("planSearch without SERV key falls back to editorial directions (no invented models)", async () => {
    const deadline = makeResaleDeadline(60_000);
    const allowed = [
      { id: "compact-toyota-corolla", segment: "Compacts", make: "Toyota", model: "Corolla" },
      { id: "crossover-honda-cr-v", segment: "Crossovers", make: "Honda", model: "CR-V" },
    ];
    const journal = emptyResaleJournal();
    const out = await planSearch({
      surface: "resale",
      budgetUsd: 14_000,
      allowedDirections: allowed,
      journal,
      recordedAt: "2026-11-11T00:00:00.000Z",
      deadline,
      // no servKey
    });
    expect(out.source).toBe("skipped_no_key");
    expect(out.directionIds).toEqual(allowed.map((d) => d.id));
    expect(out.proofRecords.some((row) => row.purpose === "resale_plan_search")).toBe(true);
    // Status is normalized for the shared proof schema (skipped_no_key → skipped*).
    expect(String(out.proofRecords[0]?.status ?? "")).toMatch(/^skipped/);
  });
});
