import { buildAgentVerdictFromReport } from "@/domain/agent-trail";
import { buildComputedReport } from "@/domain/report";
import { templateExplanation } from "@/domain/template";
import type { FullReport, Mode } from "@/domain/types";
import { sampleListings } from "@/io/sample";

/**
 * Labeled sample report that demonstrates an agent trail where the primary
 * choice was revised after new evidence, then a second check disagreed with
 * evidence and lowered confidence. Fixture only — not a live agent call.
 *
 * Keeps the labeled Camry economics (fair price / fair range) intact for
 * cross-surface price tests; the revision story lives on agentVerdict.
 */
export function buildSampleReport(mode: Mode = "personal"): FullReport {
  const listings = sampleListings();
  const createdAt = "2026-11-04T00:00:00.000Z";
  const subject = listings[0];
  if (!subject) throw new Error("sample fixture is empty");
  const computed = buildComputedReport({
    mode,
    subject,
    candidates: listings,
    recalls: [],
    recallsAvailable: false,
    complaintCount: null,
    fuel: null,
    vinDecode: null,
    distanceToSearchZipMiles: null,
    checkedAt: createdAt,
    externalLookupsPerformed: false,
    sample: true,
  });

  computed.decision = {
    action: "negotiate",
    source: "serv",
    servChoice: "buy",
    deterministicAction: "negotiate",
    overrideReasons: [],
    labeledFallback: false,
    note: "Ask sits near fair value with enough similar listings.",
    withholdReason: null,
    gates: [
      { id: "identity", status: "passed", reason: "VIN and listing identity match." },
      { id: "comps", status: "passed", reason: "Enough similar listings." },
      { id: "safety", status: "caution", reason: "Recall lookup was unavailable on this labeled sample." },
    ],
  };

  computed.agentVerdict = buildAgentVerdictFromReport({
    verdict: "negotiate",
    confidence: "medium",
    hadServStep: true,
    primaryNote: "Ask sits near fair value with enough similar listings.",
    primarySource: "serv",
    reasons: [
      {
        evidenceId: "ev_fair_value",
        text: "Fair value from similar listings supports a buy-or-negotiate band.",
      },
      {
        evidenceId: "ev_comp_count",
        text: `Similar listing count: ${computed.comps.length}.`,
      },
    ],
    risks: [
      {
        evidenceId: "ev_recall_unavailable",
        text: "NHTSA recall lookup was unavailable on this labeled sample.",
      },
    ],
    unknowns: [
      "Title brands are not checked in this sample.",
      "Accident history is not verified in this sample.",
      "Recall campaigns were not available for this labeled sample.",
    ],
    revised: {
      before: "buy",
      after: "Lemonless AI revised to negotiate after new similar-listing evidence.",
      why: "Two newer comps arrived with lower asks, so buy was no longer the honest action.",
    },
    secondPass: {
      status: "disagreed",
      action: "needs_inspection",
      objection:
        "Recall lookup was unavailable — do not treat a missing check as a clean history.",
      evidenceIds: ["ev_recall_unavailable"],
      confidenceBefore: "high",
      confidenceAfter: "medium",
    },
    servCalls: 2,
    costNote: "Labeled sample — no live agent spend.",
  });

  return {
    id: "sample",
    createdAt,
    explanation: templateExplanation(computed),
    computed,
    proof: {
      version: "autoflip.proof.v1",
      inputsHash: "sample",
      model: null,
      promptVersion: "sample",
      steps: [
        { id: "sample_fixture", status: "labeled", detail: "Not a live listings search." },
        {
          id: "serv_verdict_decide",
          status: "ok",
          detail: "Labeled sample: first chose buy, then revised to negotiate after new comps.",
        },
        {
          id: "serv_verdict_challenge",
          status: "disagreed",
          detail: "Labeled sample second check cited missing recall evidence.",
        },
      ],
      toolOutputs: {
        sample: true,
        verdict: computed.verdict,
        agentVerdict: computed.agentVerdict,
      },
      explanationSource: "template",
      shadow: { requested: false, hint: "", maxIterations: 0, outcome: "not_run" },
    },
  };
}
