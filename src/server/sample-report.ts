import { applyAgentSecondPass } from "@/domain/agent-second-pass";
import { buildAgentVerdictFromReport } from "@/domain/agent-trail";
import { buildComputedReport } from "@/domain/report";
import { templateExplanation } from "@/domain/template";
import type { FullReport, Mode } from "@/domain/types";
import { parseServVerdict } from "@/domain/verdict-decide";
import revisionFixture from "../../fixtures/serv/verdict-revision.json";
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

  const first = parseServVerdict(JSON.stringify(revisionFixture.first));
  const revised = parseServVerdict(JSON.stringify(revisionFixture.revised));
  if (!first || !revised || first.verdict === revised.verdict) {
    throw new Error("Verdict revision fixture must parse as two different SERV choices.");
  }
  const challenge = applyAgentSecondPass({
    primaryAction: revised.verdict,
    confidence: "high",
    rawText: JSON.stringify(revisionFixture.challenge),
    allowedEvidenceIds: new Set(["ev_recall_unavailable", "ev_fair_value", "ev_comp_count"]),
  });
  if (challenge.status !== "disagreed") {
    throw new Error("Verdict revision fixture challenge must disagree with a real evidence id.");
  }

  computed.decision = {
    action: revised.verdict,
    source: "serv",
    servChoice: first.verdict,
    deterministicAction: "negotiate",
    overrideReasons: [],
    labeledFallback: false,
    note: revised.note,
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
    hadServStep: false,
    primaryNote: first.note,
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
      before: first.verdict,
      after: `Saved agent response revised the choice to ${revised.verdict}.`,
      why: revised.note,
    },
    secondPass: challenge,
    servCalls: 0,
    costNote: "Labeled fixture replay of saved agent responses — no live spend.",
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
          detail: `Labeled fixture: first response ${first.verdict}, revised response ${revised.verdict}.`,
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
