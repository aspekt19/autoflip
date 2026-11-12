/**
 * C2 find_triage SERV runner — shortlist 3–8 from the inventory pool.
 * Falls back to code score shortlist when SERV fails validation after one repair.
 */
import { bestDealCarKey } from "@/domain/find-car-consistency";
import {
  isImplausibleAskUsd,
  selectBestDealOnEvidence,
  type BestDealCandidate,
  type BestDealListing,
  type BestDealResult,
} from "@/domain/find-best-deal";
import type { FindFreeGovReceipt } from "@/domain/find-free-gov";
import {
  validateFindTriage,
  type FindTriage,
  type FindTriageIssue,
} from "@/domain/find-triage";
import type { StructuredNeed } from "@/domain/need";
import type { Listing } from "@/domain/types";
import {
  buildDecisionProofRecord,
  VERDICT_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";
import { providerResponseId } from "@/domain/serv-response-id";
import { extractServJson, tryExtractServJson } from "@/domain/serv-json";
import { chatCompletionContent, profile } from "@/server/serv";
import type { ServDeps } from "@/server/serv";
import { callStep } from "@/server/serv/call-step";
import { classifyServTransportError } from "@/server/serv/transport-error";

export type FindTriageServResult = {
  triage: FindTriage;
  source: "SERV" | "code";
  bestDeal: BestDealResult;
  shortlistKeys: string[];
  proofRecords: DecisionProofRecord[];
};

function receiptEvidenceId(r: FindFreeGovReceipt): string {
  return `${r.checkId}:${r.make}|${r.model}|${r.year}`.toLowerCase();
}

function poolFacts(listings: readonly BestDealListing[], receipts: readonly FindFreeGovReceipt[]) {
  return listings.map((row) => {
    const key = bestDealCarKey(row);
    const mmyReceipts = receipts.filter(
      (r) =>
        r.make.toLowerCase() === row.make.toLowerCase() &&
        r.model.toLowerCase() === row.model.toLowerCase() &&
        r.year === row.year,
    );
    return {
      key,
      year: row.year,
      make: row.make,
      model: row.model,
      priceUsd: row.priceUsd ?? null,
      miles: row.miles ?? null,
      drivetrain: row.drivetrain ?? null,
      fuel: row.fuel ?? null,
      bodyStyle: row.bodyStyle ?? null,
      accidentCount: row.accidentCount ?? null,
      cpo: row.cpo ?? null,
      evidenceIds: [
        `car:${key}`,
        ...(typeof row.priceUsd === "number" ? [`ask:${key}`] : []),
        ...mmyReceipts.map(receiptEvidenceId),
      ],
    };
  });
}

function codeShortlist(bestDeal: BestDealResult): FindTriage {
  const ranked = bestDeal.ranked.filter((row) => !row.excludedFromPick);
  const take = ranked.slice(0, Math.min(8, Math.max(3, ranked.length)));
  const shortlist = take.map((row) => ({
    key: row.key,
    reason: "Code score shortlist (AI triage unavailable).",
    evidenceIds: [`car:${row.key}`],
  }));
  return {
    shortlist,
    rejected: [],
    perCarChecks: [],
    revisit: { needed: false, why: null, addModels: [], widenRadiusMiles: null },
  };
}

function redactIssues(issues: readonly FindTriageIssue[]): string {
  return issues
    .slice(0, 6)
    .map((i) => `${i.field}: ${i.message}`.slice(0, 160))
    .join("; ");
}

function failureKindDetail(input: {
  timedOut: boolean;
  aborted: boolean;
  network: boolean;
  unparseable: boolean;
  validationFailed: boolean;
  issuesText: string;
}): string {
  if (input.timedOut) return "SERV triage timed out waiting for a reply.";
  if (input.aborted) return "SERV triage was aborted before a reply arrived.";
  if (input.network) return "SERV triage hit a network error.";
  if (input.unparseable) return "SERV triage reply was unparseable.";
  if (input.validationFailed) {
    return `SERV triage did not pass validation${input.issuesText ? ` (${input.issuesText})` : ""}.`;
  }
  return "SERV triage did not finish.";
}

export async function runFindTriageServ(input: {
  need: StructuredNeed;
  listings: readonly BestDealListing[];
  receipts: readonly FindFreeGovReceipt[];
  marketPool?: readonly Listing[];
  revisitAlreadyUsed?: boolean;
  servKey?: string | null;
  servBaseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  transportPolicy?: ServDeps["transportPolicy"];
}): Promise<FindTriageServResult> {
  const bestDeal = selectBestDealOnEvidence({
    need: input.need,
    listings: input.listings,
    receipts: input.receipts,
    marketPool: input.marketPool,
    shortlistMax: 8,
  });
  // Never hand SERV implausible asks or hard-excluded cars — code already flagged them.
  const poolRows = (bestDeal.allRanked.length > 0 ? bestDeal.allRanked : bestDeal.ranked).filter(
    (row) => !row.excludedFromPick && !isImplausibleAskUsd(row.priceUsd),
  );
  const poolKeys = poolRows.map((row) => row.key);
  const poolKeySet = new Set(poolKeys);
  const poolListings = input.listings.filter((row) => poolKeySet.has(bestDealCarKey(row)));
  const allowedEvidenceIds = new Set<string>();
  for (const row of poolRows) {
    allowedEvidenceIds.add(`car:${row.key}`);
    if (typeof row.priceUsd === "number") allowedEvidenceIds.add(`ask:${row.key}`);
  }
  for (const r of input.receipts) {
    allowedEvidenceIds.add(receiptEvidenceId(r));
  }

  const recordedAt = new Date().toISOString();
  const proofRecords: DecisionProofRecord[] = [];
  const servKey = input.servKey?.trim() || "";

  if (servKey && poolKeys.length >= 1) {
    const facts = {
      intent: {
        note: input.need.note ?? null,
        budgetUsd: input.need.budgetUsd ?? null,
        yearMin: input.need.yearMin ?? null,
        yearMax: input.need.yearMax ?? null,
        milesMax: input.need.milesMax ?? null,
        mustHaves: input.need.mustHaves ?? [],
        priorities: input.need.priorities ?? [],
        awdPreference: Boolean(input.need.awdPreference),
      },
      pool: poolFacts(poolListings, input.receipts),
      codeRankedKeys: poolRows.slice(0, 8).map((row: BestDealCandidate) => row.key),
      poolKeys,
      allowedEvidenceIds: [...allowedEvidenceIds],
      revisitAlreadyUsed: Boolean(input.revisitAlreadyUsed),
    };

    const validateTriageText = (text: string) => {
      try {
        const payload = extractServJson(text);
        const validated = validateFindTriage(payload, {
          poolKeys,
          allowedEvidenceIds,
          revisitAlreadyUsed: input.revisitAlreadyUsed,
        });
        if (validated.ok) return { ok: true as const };
        return { ok: false as const, issues: validated.issues };
      } catch (err) {
        const message =
          err instanceof Error && err.message.trim()
            ? err.message.trim()
            : "Reply was not valid JSON.";
        return {
          ok: false as const,
          issues: [{ field: "triage", message }],
        };
      }
    };

    const step = await callStep({
      profileId: "find_triage",
      user: JSON.stringify({ facts }),
      critical: false,
      validate: validateTriageText,
      deps: {
        fetch: input.fetchImpl,
        apiKey: servKey,
        baseUrl: input.servBaseUrl,
        model: input.model,
        transportPolicy: input.transportPolicy,
        timeoutMs: profile("find_triage").timeoutMs,
      },
    });

    const judged = step.result;
    const rawResponse =
      chatCompletionContent(judged.proof?.openserv) ?? (judged.ok ? judged.text : null) ?? null;
    const responseId = providerResponseId(
      typeof judged.proof?.openserv?.id === "string" ? judged.proof.openserv.id : null,
    );
    const transportClass = judged.ok
      ? null
      : judged.transportErrorClass ?? classifyServTransportError(new Error(judged.error)).class;

    let validated:
      | ReturnType<typeof validateFindTriage>
      | { ok: false; issues: FindTriageIssue[] } = {
      ok: false,
      issues: step.validationIssues ?? [{ field: "triage", message: "SERV triage did not finish." }],
    };
    let unparseable = false;
    if (step.status === "ok" && judged.ok && judged.text?.trim()) {
      const payload = tryExtractServJson(judged.text);
      if (payload == null) {
        unparseable = true;
        validated = { ok: false, issues: [{ field: "triage", message: "Reply was not valid JSON." }] };
      } else {
        validated = validateFindTriage(payload, {
          poolKeys,
          allowedEvidenceIds,
          revisitAlreadyUsed: input.revisitAlreadyUsed,
        });
      }
    } else if (judged.ok && !judged.text?.trim()) {
      unparseable = true;
    } else if (step.validationIssues?.some((i) => i.field === "triage" && /JSON/i.test(i.message))) {
      unparseable = true;
    }

    if (validated.ok) {
      proofRecords.push(
        buildDecisionProofRecord({
          purpose: "find_triage",
          rubricId: VERDICT_RUBRIC_ID,
          status: "ok",
          recordedAt,
          responseId,
          model: judged.proof?.modelReported ?? judged.proof?.modelRequested ?? input.model ?? null,
          inputs: {
            poolSize: poolKeys.length,
            shortlistSize: validated.triage.shortlist.length,
            dropped: validated.dropped,
            repaired: step.repaired,
          },
          detail: `SERV shortlisted ${validated.triage.shortlist.length} cars from ${poolKeys.length}.`,
          rawResponse,
        }),
      );
      return {
        triage: validated.triage,
        source: "SERV",
        bestDeal,
        shortlistKeys: validated.triage.shortlist.map((row) => row.key),
        proofRecords,
      };
    }

    const issuesText = validated.ok === false ? redactIssues(validated.issues) : "";
    const detail = failureKindDetail({
      timedOut: transportClass === "timeout",
      aborted: transportClass === "abort",
      network: transportClass === "network",
      unparseable,
      validationFailed: !unparseable && validated.ok === false,
      issuesText,
    });
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "find_triage",
        rubricId: VERDICT_RUBRIC_ID,
        status: "failed",
        recordedAt,
        responseId,
        model: judged.proof?.modelReported ?? judged.proof?.modelRequested ?? input.model ?? null,
        inputs: {
          poolSize: poolKeys.length,
          issues: validated.ok === false ? validated.issues : [],
          transportErrorClass: transportClass,
          repaired: step.repaired,
        },
        detail: `${detail} Code score shortlist published instead.`,
        rawResponse,
      }),
    );
  } else {
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "find_triage",
        rubricId: VERDICT_RUBRIC_ID,
        status: servKey ? "failed" : "skipped_no_key",
        recordedAt,
        inputs: { poolSize: poolKeys.length },
        detail: servKey
          ? "Pool empty — code shortlist only."
          : "SERV_API_KEY not configured — code score shortlist.",
      }),
    );
  }

  const fallback = codeShortlist(bestDeal);
  if (fallback.shortlist.length < 3 && bestDeal.ranked.length > 0) {
    fallback.shortlist = bestDeal.ranked
      .filter((row) => !row.excludedFromPick)
      .slice(0, 8)
      .map((row) => ({
        key: row.key,
        reason: "Code score shortlist (small pool).",
        evidenceIds: [`car:${row.key}`],
      }));
  }
  return {
    triage: fallback,
    source: "code",
    bestDeal,
    shortlistKeys: fallback.shortlist.map((row) => row.key),
    proofRecords,
  };
}
