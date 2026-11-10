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
  /** Plain-English scope for the confidence label (shown in the trail header). */
  confidenceWhy?: string | null;
  summary: string;
  compCount: number;
  fairValueUsd: number | null;
  /** False when there was never an asking price to rate. */
  hasAsk?: boolean;
  recallsAvailable: boolean;
  recallCount: number;
  complaintCount: number | null;
  hasVin: boolean;
  redFlagCount: number;
  unknown: string[];
  /** True only when a live agent call was recorded for this check. */
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
  // Prefer explicit hasAsk; otherwise infer from price evidence already present.
  const hasAsk =
    typeof input.hasAsk === "boolean"
      ? input.hasAsk
      : input.fairValueUsd != null || input.compCount > 0;

  if (input.kind === "listing") {
    steps.push({
      decided: `Code screened the listing for ${input.title}.`,
      why: "Listing fields, similar asks, and public records are enough for a screening verdict.",
      changed: null,
      evidenceIds: ["check:listing_extract"],
    });
  } else {
    steps.push({
      decided: `Code built a VIN dossier for ${input.title}.`,
      why: "Government VIN decode, public safety records, and any current dealer listing for this VIN.",
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
      why: "The same adjusted-comparables price math used elsewhere on Lemonless (year window, mileage/trim adjustments).",
      changed: null,
      evidenceIds: ["check:comps"],
    });
  } else if (!hasAsk) {
    steps.push({
      decided: "No asking price was available, so this check did not rate price.",
      why: "Price rating needs a current listing ask (and mileage) for this VIN or listing.",
      changed: null,
      evidenceIds: ["check:no_ask"],
    });
  } else {
    steps.push({
      decided: "Not enough similar cars for a price rating.",
      why: "Fewer than the minimum similar asks after a widened year window and nationwide fallback, or adjusted prices were too far apart.",
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
      decided: "No OpenServ buy/negotiate/pass call ran for this check.",
      why: !hasAsk
        ? "There was no asking price (and usually no mileage) to decide against — OpenServ only runs when that evidence exists."
        : input.compCount < 3
          ? "Similar listings were still too thin after a widened search, so OpenServ had nothing solid to decide against."
          : "OpenServ was not configured for this environment, or evidence gates blocked a spend.",
      changed: null,
    });
  }

  const confidenceScope =
    input.confidenceWhy?.trim() ||
    (hasAsk && (input.compCount > 0 || input.fairValueUsd != null)
      ? "Verdict confidence from similar listings and public records."
      : "Covers public-record identity and safety only — not a price rating.");

  return emptyAgentVerdict({
    pick: null,
    verdict: null,
    reasons: [
      {
        evidenceId: "check:verdict",
        text: `${input.verdictLabel} · Confidence ${input.confidence} — ${confidenceScope}`,
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
        : {
            calls: 0,
            costNote: !hasAsk
              ? "No agent spend — no asking price to decide against."
              : "No agent spend on this check.",
          },
    no_serv_step: !hadServ,
  });
}
