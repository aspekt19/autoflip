/**
 * C2 find_triage SERV runner — shortlist 3–8 from the inventory pool.
 * Falls back to code score shortlist when SERV fails validation.
 */
import { bestDealCarKey } from "@/domain/find-car-consistency";
import {
  selectBestDealOnEvidence,
  type BestDealCandidate,
  type BestDealListing,
  type BestDealResult,
} from "@/domain/find-best-deal";
import type { FindFreeGovReceipt } from "@/domain/find-free-gov";
import {
  validateFindTriage,
  type FindTriage,
} from "@/domain/find-triage";
import type { StructuredNeed } from "@/domain/need";
import type { Listing } from "@/domain/types";
import {
  buildDecisionProofRecord,
  VERDICT_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";
import { providerResponseIdFromCall } from "@/domain/serv-response-id";
import { chatCompletionContent, profile, runServ } from "@/server/serv";
import type { ServDeps } from "@/server/serv";

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
  // When pool is tiny, pad is impossible — validator needs 3; caller must ensure pool ≥3 or accept fail.
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
  const poolKeys = bestDeal.ranked.map((row) => row.key);
  const allowedEvidenceIds = new Set<string>();
  for (const row of bestDeal.ranked) {
    allowedEvidenceIds.add(`car:${row.key}`);
    if (typeof row.priceUsd === "number") allowedEvidenceIds.add(`ask:${row.key}`);
  }
  for (const r of input.receipts) {
    allowedEvidenceIds.add(receiptEvidenceId(r));
  }

  const recordedAt = new Date().toISOString();
  const proofRecords: DecisionProofRecord[] = [];
  const servKey = input.servKey?.trim() || "";

  if (servKey && poolKeys.length >= 3) {
    const facts = {
      intent: {
        note: input.need.note ?? null,
        budgetUsd: input.need.budgetUsd ?? null,
        yearMin: input.need.yearMin ?? null,
        yearMax: input.need.yearMax ?? null,
        milesMax: input.need.milesMax ?? null,
        mustHaves: input.need.mustHaves ?? [],
        priorities: input.need.priorities ?? [],
      },
      pool: poolFacts(input.listings, input.receipts),
      codeRankedKeys: bestDeal.ranked.slice(0, 8).map((row: BestDealCandidate) => row.key),
      poolKeys,
      allowedEvidenceIds: [...allowedEvidenceIds],
      revisitAlreadyUsed: Boolean(input.revisitAlreadyUsed),
    };
    const judged = await runServ(
      "find_triage",
      { user: JSON.stringify({ facts }) },
      {
        fetch: input.fetchImpl,
        apiKey: servKey,
        baseUrl: input.servBaseUrl,
        model: input.model,
        transportPolicy: input.transportPolicy,
        timeoutMs: profile("find_triage").timeoutMs,
      },
    );
    let payload: unknown = null;
    if (judged.ok && judged.text?.trim()) {
      try {
        payload = JSON.parse(judged.text);
      } catch {
        payload = null;
      }
    }
    const validated = validateFindTriage(payload, {
      poolKeys,
      allowedEvidenceIds,
      revisitAlreadyUsed: input.revisitAlreadyUsed,
    });
    const rawResponse =
      chatCompletionContent(judged.proof?.openserv) ?? (judged.ok ? judged.text : null) ?? null;
    const responseId = providerResponseIdFromCall({
      ok: judged.ok && validated.ok,
      id: typeof judged.proof?.openserv?.id === "string" ? judged.proof.openserv.id : null,
    });
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
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "find_triage",
        rubricId: VERDICT_RUBRIC_ID,
        status: "failed",
        recordedAt,
        responseId: null,
        model: judged.proof?.modelReported ?? judged.proof?.modelRequested ?? input.model ?? null,
        inputs: {
          poolSize: poolKeys.length,
          issues: validated.ok === false ? validated.issues : [],
        },
        detail: "SERV triage failed validation — code score shortlist published.",
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
          ? "Pool under 3 cars — code shortlist only."
          : "SERV_API_KEY not configured — code score shortlist.",
      }),
    );
  }

  const fallback = codeShortlist(bestDeal);
  // When fewer than 3 cars, still return what we have (decide path handles tiny pools).
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
