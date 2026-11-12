/**
 * Turn a pipeline result into a stored Run. Routes call this after the real work.
 * A thrown store error must not fail the shopper's search, so callers catch.
 */
import type { FailureReasonId, RunKind, SourceId } from "@/domain/buyer-copy-table";
import {
  applyObservation,
  createRun,
  newRunId,
  type ProofObservation,
  type RunInputs,
  type RunListing,
  type RunObservation,
  type RunRecord,
} from "@/domain/run";
import { buildPurchaseReadiness } from "@/domain/purchase-readiness";
import { resaleEdgeSentence } from "@/domain/resale-presentation";
import type { BestDealResult } from "@/domain/find-best-deal";
import { buildSearchSpec, type SearchFormEdits, type SearchSpec } from "@/domain/search-spec";
import type { Kv } from "@/io/kv";
import { insertRun, readRun, updateRun } from "@/io/run-store";
import { releaseFindSearchCredit } from "@/server/find-search-credit";

export type SyncRunInput = {
  runId?: string | null;
  ownerId: string;
  kind: RunKind;
  note: string;
  clarifications?: string[];
  mode?: "personal" | "flip";
  vin?: string | null;
  formEdits?: SearchFormEdits | null;
  spec?: SearchSpec | null;
  proofs?: ProofObservation[];
  listings?: RunListing[];
  picks?: string[];
  sources?: SourceId[];
  queryCount?: number | null;
  verdict?: string | null;
  confidence?: string | null;
  creditsCharged?: number;
  failureReasons?: FailureReasonId[];
  spendKey?: string | null;
  buyerMessage?: string | null;
  confidenceReason?: string | null;
  terminal?: boolean;
};

function inputsFrom(input: SyncRunInput, prior: RunInputs | null): RunInputs {
  const clarifications = [...(prior?.clarifications ?? [])];
  for (const line of input.clarifications ?? []) {
    const text = line.trim();
    if (text && !clarifications.includes(text)) clarifications.push(text);
  }
  return {
    note: input.note.trim() || prior?.note || "",
    clarifications,
    mode: input.mode ?? prior?.mode ?? (input.kind === "resale" ? "flip" : "personal"),
    vin: input.vin !== undefined ? input.vin : (prior?.vin ?? null),
    formEdits: input.formEdits ?? prior?.formEdits ?? null,
  };
}

function observationFrom(input: SyncRunInput): RunObservation {
  return {
    note: input.note,
    clarifications: input.clarifications,
    formEdits: input.formEdits,
    vin: input.vin,
    spec: input.spec,
    proofs: input.proofs,
    listings: input.listings,
    picks: input.picks,
    sources: input.sources,
    queryCount: input.queryCount,
    verdict: input.verdict,
    confidence: input.confidence,
    creditsCharged: input.creditsCharged,
    failureReasons: input.failureReasons,
    spendKey: input.spendKey,
    buyerMessage: input.buyerMessage,
    confidenceReason: input.confidenceReason,
    terminal: input.terminal,
  };
}

async function refundIfUnpublished(kv: Kv, ownerId: string, before: number, next: RunRecord | null): Promise<void> {
  if (!next || next.creditsCharged > 0 || !next.spendKey || before <= 0) return;
  try {
    await releaseFindSearchCredit(kv, ownerId, next.spendKey);
  } catch {
    /* The stored run already says nothing was charged. */
  }
}

/** Create or update the owner's run. Returns the id, or null when the store rejects the write. */
export async function syncRun(kv: Kv, input: SyncRunInput): Promise<string | null> {
  const requested = input.runId?.trim() || null;
  if (requested) {
    const existing = await readRun(kv, requested);
    if (existing && existing.ownerId === input.ownerId && existing.kind === input.kind) {
      const before = Math.max(existing.creditsCharged, input.creditsCharged ?? 0);
      const next = await updateRun(kv, existing.id, (current) => applyObservation(current, observationFrom(input)));
      await refundIfUnpublished(kv, input.ownerId, before, next);
      return next?.id ?? null;
    }
    if (existing) return null;
  }

  let record = createRun({
    id: requested ?? newRunId(),
    ownerId: input.ownerId,
    kind: input.kind,
    inputs: inputsFrom(input, null),
  });
  record = applyObservation(record, observationFrom(input));
  const inserted = await insertRun(kv, record);
  if (inserted) {
    await refundIfUnpublished(kv, input.ownerId, input.creditsCharged ?? 0, record);
    return record.id;
  }
  const raced = await readRun(kv, record.id);
  if (!raced || raced.ownerId !== input.ownerId) return null;
  const next = await updateRun(kv, raced.id, (current) => applyObservation(current, observationFrom(input)));
  return next?.id ?? null;
}

export function proofsFromRecords(records: unknown): ProofObservation[] {
  if (!Array.isArray(records)) return [];
  const out: ProofObservation[] = [];
  for (const row of records) {
    if (!row || typeof row !== "object") continue;
    const rec = row as {
      purpose?: unknown;
      status?: unknown;
      servResponseId?: unknown;
      model?: unknown;
      timestamp?: unknown;
      detail?: unknown;
    };
    if (typeof rec.purpose !== "string" || !rec.purpose.trim()) continue;
    out.push({
      purpose: rec.purpose,
      status: typeof rec.status === "string" ? rec.status : null,
      responseId: typeof rec.servResponseId === "string" ? rec.servResponseId : null,
      model: typeof rec.model === "string" ? rec.model : null,
      timestamp: typeof rec.timestamp === "string" ? rec.timestamp : null,
      detail: typeof rec.detail === "string" ? rec.detail : null,
    });
  }
  return out;
}

export function listingFromCar(car: {
  vin?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  priceUsd?: number | null;
  miles?: number | null;
  dealer?: string | null;
  vdp?: string | null;
  city?: string | null;
  state?: string | null;
  drivetrain?: string | null;
  accidentCount?: number | null;
  bodyStyle?: string | null;
  offerUsd?: number | null;
  offerLabel?: string | null;
  reason?: string | null;
  confidence?: string | null;
}): RunListing | null {
  const vin = car.vin?.trim();
  if (!vin) return null;
  return {
    vin,
    year: typeof car.year === "number" && Number.isFinite(car.year) ? car.year : 0,
    make: car.make?.trim() || "",
    model: car.model?.trim() || "",
    trim: car.trim?.trim() || null,
    priceUsd: typeof car.priceUsd === "number" ? car.priceUsd : null,
    miles: typeof car.miles === "number" ? car.miles : null,
    dealer: car.dealer?.trim() || null,
    vdp: car.vdp?.trim() || null,
    city: car.city?.trim() || null,
    state: car.state?.trim() || null,
    drivetrain: car.drivetrain?.trim() || null,
    accidentCount: typeof car.accidentCount === "number" ? car.accidentCount : null,
    bodyStyle: car.bodyStyle?.trim() || null,
    offerUsd: typeof car.offerUsd === "number" ? car.offerUsd : null,
    offerLabel: car.offerLabel?.trim() || null,
    reason: car.reason?.trim() || null,
    confidence: car.confidence?.trim() || null,
  };
}

/** The cars, offers, and reasons the permalink and the live page both render. */
export function listingsFromBestDeal(deal: BestDealResult | null, verdict: string | null): RunListing[] {
  const ranked = deal?.ranked ?? [];
  if (!ranked.length) return [];
  const pool = ranked.map((car) => ({
    vin: car.vin,
    year: car.year,
    make: car.make,
    model: car.model,
    trim: car.trim ?? null,
    priceUsd: car.priceUsd,
    miles: car.miles,
    accidentCount: car.accidentCount ?? null,
  }));
  const now = new Date();
  return ranked.flatMap((car) => {
    const offer = verdict
      ? buildPurchaseReadiness({
          car: pool.find((row) => row.vin === car.vin) ?? pool[0]!,
          pool,
          zip: null,
          zipUsedFor: null,
          now,
        }).offer
      : null;
    const row = listingFromCar({
      vin: car.vin,
      year: car.year,
      make: car.make,
      model: car.model,
      trim: car.trim,
      priceUsd: car.priceUsd,
      miles: car.miles,
      dealer: car.dealer,
      vdp: car.vdp,
      city: car.city,
      state: car.state,
      drivetrain: car.drivetrain,
      accidentCount: car.accidentCount,
      reason: car.vin && car.vin === deal?.pick?.vin ? deal?.why : car.excludedReason,
      offerUsd: offer?.openingUsd ?? null,
      offerLabel: offer?.openingLabel ?? null,
      confidence: null,
    });
    return row ? [row] : [];
  });
}

export async function loadOwnedRun(kv: Kv, id: string, ownerId: string): Promise<RunRecord | null> {
  const run = await readRun(kv, id);
  if (!run || run.ownerId !== ownerId) return null;
  return run;
}

/** Store the run, but never fail the shopper request when the store errors. */
export async function syncRunSafely(kv: Kv, input: SyncRunInput): Promise<string | null> {
  try {
    return await syncRun(kv, input);
  } catch {
    return null;
  }
}

type ResaleCar = {
  vin?: string | null;
  profitLowUsd?: number | null;
  profitMidUsd?: number | null;
  targetProfitUsd?: number | null;
  confidence?: string | null;
  reason?: string | null;
  listing?: {
    year?: number | null;
    make?: string | null;
    model?: string | null;
    trim?: string | null;
    priceUsd?: number | null;
    miles?: number | null;
    dealer?: string | null;
    vdp?: string | null;
    city?: string | null;
    state?: string | null;
  } | null;
};

function resaleFormEdits(input: {
  budgetUsd: number;
  zip: string | null;
  distanceMiles: number | null;
  yearMin: number | null;
  yearMax: number | null;
  milesMax: number | null;
  sellWithinDays: number | null;
}): SearchFormEdits {
  return {
    priceMaxUsd: { value: input.budgetUsd, dirty: true },
    zip: { value: input.zip, dirty: true },
    radiusMi: { value: input.distanceMiles, dirty: true },
    yearMin: { value: input.yearMin, dirty: input.yearMin != null },
    yearMax: { value: input.yearMax, dirty: input.yearMax != null },
    milesMax: { value: input.milesMax, dirty: input.milesMax != null },
    sellWithinDays: { value: input.sellWithinDays, dirty: input.sellWithinDays != null },
  };
}

/** Record a resale job step onto the Run. Plan-only steps stay in progress. */
export async function syncResaleRun(
  kv: Kv,
  input: {
    ownerId: string;
    runId?: string | null;
    note: string;
    search?: {
      budgetUsd: number;
      zip: string | null;
      distanceMiles: number | null;
      yearMin: number | null;
      yearMax: number | null;
      milesMax: number | null;
      sellWithinDays: number | null;
    } | null;
    client: {
      best?: ResaleCar | null;
      alternatives?: ResaleCar[] | null;
      proofRecords?: unknown;
      verdictAction?: string | null;
      confidence?: string | null;
      reviewNote?: string | null;
      message?: string | null;
      chargedCredit?: boolean;
      providerQueriesUsed?: number | null;
      done?: boolean;
      emptyReason?: string | null;
      step?: number | null;
    };
  },
): Promise<string | null> {
  const bestVin = input.client.best?.vin ?? null;
  const cars = [input.client.best, ...(input.client.alternatives ?? [])].flatMap((car) => {
    if (!car) return [];
    const row = listingFromCar({ ...car.listing, vin: car.vin });
    if (!row) return [];
    const margin = car.profitMidUsd != null ? car.profitMidUsd : car.profitLowUsd;
    const summary =
      typeof margin === "number" || input.client.verdictAction
        ? resaleEdgeSentence({
            amountUsd: typeof margin === "number" ? margin : null,
            action: input.client.verdictAction ?? null,
            thresholdUsd: car.targetProfitUsd,
          })
        : null;
    return [{
      ...row,
      picked: car.vin === bestVin,
      summary,
      reason: car.reason ?? summary,
      confidence: input.client.confidence ?? null,
    }];
  });
  const queries = typeof input.client.providerQueriesUsed === "number" ? input.client.providerQueriesUsed : 0;
  const finished = input.client.done === true || Boolean(input.client.emptyReason);
  const sources: SourceId[] = [];
  if (queries > 0) sources.push("cars_for_sale");
  if (cars.length > 1) sources.push("similar_cars");
  const formEdits = input.search ? resaleFormEdits(input.search) : null;
  const spec = formEdits
    ? buildSearchSpec({ note: input.note, mode: "flip", formEdits })
    : null;
  const failureReasons: FailureReasonId[] = [];
  if (finished && !bestVin) failureReasons.push("no_qualifying_flip");
  if (finished && input.client.reviewNote) failureReasons.push("review_unavailable");
  return syncRunSafely(kv, {
    runId: input.runId,
    ownerId: input.ownerId,
    kind: "resale",
    mode: "flip",
    note: input.note,
    formEdits,
    spec,
    proofs: proofsFromRecords(input.client.proofRecords),
    listings: finished || cars.length > 0 ? cars : undefined,
    picks: bestVin ? [bestVin] : undefined,
    sources,
    queryCount: finished || queries > 0 ? queries : undefined,
    verdict: finished ? (input.client.verdictAction ?? null) : null,
    confidence: finished ? (input.client.confidence ?? null) : null,
    buyerMessage: finished ? (input.client.message ?? null) : null,
    confidenceReason:
      finished && input.client.confidence
        ? `${input.client.confidence}: this is the confidence for this resale result.`
        : null,
    failureReasons,
    creditsCharged: input.client.chargedCredit ? 1 : 0,
    terminal: finished,
  });
}
