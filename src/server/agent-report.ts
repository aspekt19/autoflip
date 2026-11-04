import type { FullReport } from "@/domain/types";
import { agentProof, type ServProof } from "@/server/serv";

const CODE_FIELDS = ["fairValueUsd", "priceGap", "percentile", "score", "recalls", "complaintCount", "flip", "subject"];

/** Agent payload: the verdict and the math, without photos or history-report links. */
export function agentReport(report: FullReport) {
  const { primaryImage: _image, carfaxUrl: _carfax, ...subject } = report.computed.subject;
  return {
    id: report.id,
    createdAt: report.createdAt,
    explanation: report.explanation,
    verdict: report.computed.verdict,
    mode: report.computed.mode,
    sample: report.computed.sample,
    subject,
    fairValueUsd: report.computed.fairValueUsd,
    priceGap: report.computed.priceGap,
    percentile: report.computed.percentile,
    score: report.computed.score,
    reasons: report.computed.reasons,
    flags: report.computed.flags,
    questions: report.computed.questions,
    comps: report.computed.comps,
    recalls: report.computed.recalls,
    complaintCount: report.computed.complaintCount,
    fuel: report.computed.fuel,
    flip: report.computed.flip,
    dataNotes: report.computed.dataNotes,
    assumptions: report.computed.assumptions,
    proof: agentProof((report.proof.servChecks ?? []) as ServProof[], CODE_FIELDS),
  };
}
