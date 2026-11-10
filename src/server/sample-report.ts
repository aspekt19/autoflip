import { buildAgentVerdictFromReport } from "@/domain/agent-trail";
import { emptyAgentVerdict } from "@/domain/agent-verdict-schema";
import { buildComputedReport } from "@/domain/report";
import { templateExplanation } from "@/domain/template";
import type { FullReport, Mode } from "@/domain/types";
import { sampleListings } from "@/io/sample";
import { loadServRevisionRecording } from "@/server/serv-revision-recording";

/**
 * Labeled sample report for /report/sample.
 *
 * Camry economics stay labeled fixtures (explicitly sample).
 * Agent revision / second-check trail is shown ONLY when a real live
 * recording exists at fixtures/serv/recordings/verdict-revision.latest.json.
 * Otherwise the trail says "example not yet recorded" — never invent SERV text.
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

  const loaded = loadServRevisionRecording();

  if (loaded.ok) {
    const { recording, challenge } = loaded;
    computed.decision = {
      action: recording.revised.parsed.verdict,
      source: "serv",
      servChoice: recording.first.parsed.verdict,
      deterministicAction: "negotiate",
      overrideReasons: [],
      labeledFallback: false,
      note: recording.revised.parsed.note,
      withholdReason: null,
      gates: [
        { id: "identity", status: "passed", reason: "VIN and listing identity match." },
        { id: "comps", status: "passed", reason: "Enough similar listings." },
        { id: "safety", status: "caution", reason: "Safety evidence as recorded in the live capture." },
      ],
    };
    computed.agentVerdict = buildAgentVerdictFromReport({
      verdict: recording.revised.parsed.verdict,
      confidence: challenge.confidenceAfter ?? "medium",
      hadServStep: true,
      primaryNote: recording.first.parsed.note,
      primarySource: "serv",
      reasons: [
        {
          evidenceId: "ev_fair_value",
          text: "Fair value from similar listings in the recorded facts.",
        },
      ],
      risks: [],
      unknowns: [
        "This sample replays a recorded live SERV revision — see provenance on the trail.",
      ],
      revised: {
        before: recording.first.parsed.verdict,
        after: `Recorded agent response revised the choice to ${recording.revised.parsed.verdict}.`,
        why: recording.revised.parsed.note,
      },
      secondPass: challenge,
      servCalls: 2,
      costNote:
        recording.costNote ??
        `Live recording ${recording.recordedAt} · model ${recording.model}` +
          (recording.costUsd != null ? ` · ~$${recording.costUsd}` : ""),
    });

    return {
      id: "sample",
      createdAt,
      explanation: templateExplanation(computed),
      computed,
      proof: {
        version: "autoflip.proof.v1",
        inputsHash: "sample",
        model: recording.model,
        promptVersion: "sample-recorded-revision",
        steps: [
          { id: "sample_fixture", status: "labeled", detail: "Listings economics are a labeled sample." },
          {
            id: "serv_verdict_decide",
            status: "ok",
            detail: `Live recording ${recording.recordedAt}: first ${recording.first.parsed.verdict} → revised ${recording.revised.parsed.verdict}.`,
          },
          {
            id: "serv_verdict_challenge",
            status: challenge.status,
            detail: challenge.objection ?? challenge.status,
          },
        ],
        toolOutputs: {
          sample: true,
          verdict: computed.verdict,
          agentVerdict: computed.agentVerdict,
          servRevisionRecording: {
            recordedAt: recording.recordedAt,
            model: recording.model,
            provenance: recording.provenance,
          },
        },
        explanationSource: "template",
        shadow: { requested: false, hint: "", maxIterations: 0, outcome: "not_run" },
      },
    };
  }

  // No real recording — keep Camry economics, do not invent a SERV trail.
  // Use no_serv_key (not deterministic_fallback) so the UI does not claim an AI timeout.
  computed.decision = {
    action: "negotiate",
    source: "no_serv_key",
    servChoice: null,
    deterministicAction: "negotiate",
    overrideReasons: [],
    labeledFallback: true,
    note: "Labeled sample economics only. No AI call ran — agent revision example not yet recorded.",
    withholdReason: null,
    gates: [
      { id: "identity", status: "passed", reason: "VIN and listing identity match." },
      { id: "comps", status: "passed", reason: "Enough similar listings." },
      { id: "safety", status: "caution", reason: "Recall lookup was not run on this labeled sample." },
    ],
  };

  computed.agentVerdict = emptyAgentVerdict({
    pick: null,
    verdict: null,
    confidence: null,
    reasons: [
      {
        evidenceId: "ev_sample_economics",
        text: "Price figures on this page are from the labeled Camry sample listing set.",
      },
    ],
    risks: [],
    unknowns: [
      "Agent revision example not yet recorded.",
      "Title brands are not checked in this sample.",
      "Accident history is not verified in this sample.",
    ],
    serv_steps: [],
    second_pass: { status: "not_run", action: null, objection: null, evidenceIds: [], confidenceBefore: null, confidenceAfter: null },
    multipath: null,
    vs_cheapest: null,
    serv_spend: {
      calls: 0,
      costNote: "Example not yet recorded — run npm run eval:record-serv-revision to capture a real revision.",
    },
    no_serv_step: true,
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
          status: "example_not_yet_recorded",
          detail: loaded.detail,
        },
        {
          id: "serv_verdict_challenge",
          status: "example_not_yet_recorded",
          detail: "No live second-check recording on disk.",
        },
      ],
      toolOutputs: {
        sample: true,
        verdict: computed.verdict,
        agentVerdict: computed.agentVerdict,
        servRevisionRecording: null,
      },
      explanationSource: "template",
      shadow: { requested: false, hint: "", maxIterations: 0, outcome: "not_run" },
    },
  };
}
