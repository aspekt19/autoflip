/**
 * Code-only agentVerdict for /check when SERV is not configured or gates withhold.
 * Live Check with a SERV key uses runShopperVerdictServ (verdict_decide +
 * verdict_challenge) instead — never invent agent choice steps here.
 */

import { emptyAgentVerdict, type AgentVerdict, type AgentTrailStep } from "./agent-verdict-schema";
import type { CheckConfidence } from "./listing/types";

export type CheckTrailInput = {
  kind: "listing" | "vin_dossier";
  title: string;
  verdictLabel: string;
  confidence: CheckConfidence;
  summary: string;
  compCount: number;
  fairValueUsd: number | null;
  recallsAvailable: boolean;
  recallCount: number;
  complaintCount: number | null;
  hasVin: boolean;
  redFlagCount: number;
  unknown: string[];
  /** True only when a live agent call was recorded for this check (rare today). */
  hadServStep?: boolean;
  servCalls?: number;
};

function mapConfidence(level: CheckConfidence): AgentVerdict["confidence"] {
  if (level === "High") return "high";
  if (level === "Medium") return "medium";
  return "low";
}

export function buildCheckAgentVerdict(input: CheckTrailInput): AgentVerdict {
  const steps: AgentTrailStep[] = [];

  if (input.kind === "listing") {
    steps.push({
      decided: `Code screened the listing for ${input.title}.`,
      why: "Listing fields, similar asks, and public records are enough for a free screening verdict.",
      changed: null,
      evidenceIds: ["check:listing_extract"],
    });
  } else {
    steps.push({
      decided: `Code built a VIN dossier for ${input.title}.`,
      why: "Free government sources and any matching dealer listings for this VIN.",
      changed: null,
      evidenceIds: ["check:vin_dossier"],
    });
  }

  if (input.compCount > 0 || input.fairValueUsd != null) {
    steps.push({
      decided:
        input.fairValueUsd != null
          ? `Compared the ask with ${input.compCount} similar listings.`
          : `Looked at ${input.compCount} similar listings but could not publish a fair value.`,
      why: "The same adjusted-comparables price math used elsewhere on Lemonless.",
      changed: null,
      evidenceIds: ["check:comps"],
    });
  } else {
    steps.push({
      decided: "Not enough similar cars for a price rating.",
      why: "Fewer than the minimum similar asks, or the adjusted prices were too far apart.",
      changed: null,
      evidenceIds: ["check:comps_thin"],
    });
  }

  steps.push({
    decided: input.recallsAvailable
      ? `Checked model-year recalls (${input.recallCount} campaign${input.recallCount === 1 ? "" : "s"}).`
      : "Recall lookup was unavailable.",
    why: "NHTSA campaigns are model-year coverage, not proof this VIN is unrepaired.",
    changed: null,
    evidenceIds: [input.recallsAvailable ? "check:recalls" : "check:recalls_unavailable"],
  });

  if (input.complaintCount != null) {
    steps.push({
      decided: `Recorded ${input.complaintCount} model-year complaints.`,
      why: "Complaint counts are for the year/make/model, not this car's history.",
      changed: null,
      evidenceIds: ["check:complaints"],
    });
  }

  steps.push({
    decided: `Screening verdict: ${input.verdictLabel}.`,
    why: input.summary,
    changed:
      input.redFlagCount > 0
        ? `${input.redFlagCount} red flag${input.redFlagCount === 1 ? "" : "s"} from the listing text.`
        : null,
    evidenceIds: ["check:verdict"],
  });

  const hadServ = input.hadServStep === true;
  if (!hadServ) {
    steps.push({
      decided: "No agent decision step ran for this check.",
      why: "Free Check uses code and public records. A full report can add an independent agent review.",
      changed: null,
    });
  }

  return emptyAgentVerdict({
    pick: null,
    verdict: null,
    reasons: [
      {
        evidenceId: "check:verdict",
        text: `${input.verdictLabel} · Confidence ${input.confidence}.`,
      },
    ],
    risks:
      input.redFlagCount > 0
        ? [
            {
              evidenceId: "check:red_flags",
              text: `${input.redFlagCount} listing red flag${input.redFlagCount === 1 ? "" : "s"} recorded.`,
            },
          ]
        : [],
    confidence: mapConfidence(input.confidence),
    unknowns: input.unknown.slice(0, 6),
    serv_steps: steps,
    second_pass: null,
    multipath: null,
    vs_cheapest: null,
    serv_spend:
      typeof input.servCalls === "number"
        ? { calls: input.servCalls, costNote: null }
        : { calls: 0, costNote: "Free Check — no agent spend." },
    no_serv_step: !hadServ,
  });
}
