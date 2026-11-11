import { describe, expect, it } from "vitest";
import {
  accumulateServRunStats,
  AUDIT_CHAIN_GENESIS,
  buildDecisionAuditTrail,
  emptyServRunAggregateStats,
  hashReport,
  verifyDecisionAuditTrail,
} from "./decision-audit-chain";
import { emptyServDecisionStep } from "./serv-decision-step";

describe("decision-audit-chain", () => {
  it("builds a hash-linked chain that verifies", () => {
    const steps = [
      emptyServDecisionStep({
        step: "verdict_decide",
        by: "SERV",
        status: "ran",
        output: "negotiate",
        modelId: "synthetic-test-model",
        runId: "chatcmpl-synthetic-test-1",
        timestamp: "2026-11-11T12:00:00.000Z",
        inputSummary: "inputs digest synthetic",
      }),
      emptyServDecisionStep({
        step: "comps_verify",
        by: "code",
        status: "ran",
        output: "fair value from TypeScript",
        timestamp: "2026-11-11T12:00:01.000Z",
        inputSummary: "comp set",
      }),
    ];
    const reportHash = hashReport({
      id: "synthetic-test-report-1",
      createdAt: "2026-11-11T12:00:00.000Z",
      explanation: "sample",
      computed: { verdict: "fair" },
      proof: { version: "autoflip.proof.v1" },
    });
    const trail = buildDecisionAuditTrail({
      reportId: "synthetic-test-report-1",
      reportHash,
      steps,
      sealedAt: "2026-11-11T12:00:02.000Z",
    });
    expect(trail.links).toHaveLength(2);
    expect(trail.links[0]?.prevHash).toBe(AUDIT_CHAIN_GENESIS);
    expect(trail.links[1]?.prevHash).toBe(trail.links[0]?.hash);
    const verified = verifyDecisionAuditTrail(trail);
    expect(verified.ok).toBe(true);
    expect(verified.issues).toEqual([]);
  });

  it("fails verify when a link is tampered", () => {
    const trail = buildDecisionAuditTrail({
      reportId: "synthetic-test-report-2",
      reportHash: "b".repeat(64),
      steps: [
        emptyServDecisionStep({
          step: "verdict_decide",
          by: "SERV",
          status: "ran",
          output: "buy",
          runId: "chatcmpl-synthetic-test-2",
          timestamp: "2026-11-11T12:00:00.000Z",
        }),
      ],
      sealedAt: "2026-11-11T12:00:00.000Z",
    });
    const tampered = {
      ...trail,
      links: trail.links.map((link, index) =>
        index === 0 ? { ...link, step: { ...link.step, output: "tampered" } } : link,
      ),
    };
    const verified = verifyDecisionAuditTrail(tampered);
    expect(verified.ok).toBe(false);
    expect(verified.issues.some((issue) => /content hash/i.test(issue))).toBe(true);
  });

  it("accumulates stats only from real trails", () => {
    const trail = buildDecisionAuditTrail({
      reportId: "synthetic-test-report-3",
      reportHash: "c".repeat(64),
      steps: [
        emptyServDecisionStep({
          step: "verdict_decide",
          by: "SERV",
          status: "ran",
          output: "pass",
          runId: "chatcmpl-synthetic-test-3",
          timestamp: "2026-11-11T12:00:00.000Z",
        }),
        emptyServDecisionStep({
          step: "gates",
          by: "code",
          status: "ran",
          output: "passed",
          timestamp: "2026-11-11T12:00:00.000Z",
        }),
      ],
      sealedAt: "2026-11-11T12:00:00.000Z",
    });
    const stats = accumulateServRunStats(emptyServRunAggregateStats(), trail, {
      answersAgree: true,
    });
    expect(stats.trailCount).toBe(1);
    expect(stats.servCallCount).toBe(1);
    expect(stats.codeStepCount).toBe(1);
    expect(stats.secondCheckAgreements).toBe(1);
    expect(stats.secondCheckDisagreements).toBe(0);
  });
});
