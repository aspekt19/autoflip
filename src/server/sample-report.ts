import { buildComputedReport } from "@/domain/report";
import { templateExplanation } from "@/domain/template";
import type { FullReport, Mode } from "@/domain/types";
import { sampleListings } from "@/io/sample";

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
      steps: [{ id: "sample_fixture", status: "labeled", detail: "Not a live listings search." }],
      toolOutputs: { sample: true, verdict: computed.verdict },
      explanationSource: "template",
      shadow: { requested: false, hint: "", maxIterations: 0, outcome: "not_run" },
    },
  };
}
