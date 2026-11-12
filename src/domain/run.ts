/**
 * Server-side Run. The permalink and the live pages render this record.
 * A finished run's public fields are the last in-progress snapshot plus the decision.
 */
import { formatNumber, formatUsd } from "./format";
import { buildSearchSpec, type SearchFormEdits, type SearchSpec } from "./search-spec";
import {
  confidenceFromRaw,
  isFailureReasonId,
  isJournalStepId,
  isSourceId,
  journalStepForPurpose,
  verdictIdFromRaw,
  type FailureReasonId,
  type JournalStepId,
  type RunConfidence,
  type RunKind,
  type RunPhase,
  type SourceId,
  type StepStatus,
  type VerdictId,
} from "./buyer-copy-table";
import type { RunListingView, RunStepView, RunView } from "./run-view";

export type RunListing = RunListingView;

export type RunStep = RunStepView & {
  model: string | null;
  startedAt: string;
  finishedAt: string | null;
  failureReason: FailureReasonId | null;
};

export type RunInputs = {
  note: string;
  clarifications: string[];
  mode: "personal" | "flip";
  vin: string | null;
  formEdits: SearchFormEdits | null;
};

export type RunProgress = {
  at: string;
  phase: "running";
  listingVins: string[];
  pickVin: string | null;
  verdict: null;
  confidence: null;
  creditsCharged: 0;
  failureReasons: [];
  steps: JournalStepId[];
};

export type RunDecision = {
  phase: RunPhase;
  verdict: VerdictId | null;
  confidence: RunConfidence | null;
  creditsCharged: number;
  failureReasons: FailureReasonId[];
};

export type RunRecord = {
  v: 1;
  id: string;
  kind: RunKind;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  phase: RunPhase;
  inputs: RunInputs;
  spec: SearchSpec | null;
  steps: RunStep[];
  sources: SourceId[];
  listings: RunListing[];
  picks: string[];
  verdict: VerdictId | null;
  confidence: RunConfidence | null;
  creditsCharged: number;
  failureReasons: FailureReasonId[];
  /** Snapshots taken before each decision was applied. */
  progress: RunProgress[];
};

export type ProofObservation = {
  purpose: string;
  status?: string | null;
  responseId?: string | null;
  model?: string | null;
  timestamp?: string | null;
  elapsedMs?: number | null;
};

export type RunObservation = {
  note?: string;
  clarifications?: string[];
  formEdits?: SearchFormEdits | null;
  vin?: string | null;
  spec?: SearchSpec | null;
  proofs?: ProofObservation[];
  listings?: RunListing[];
  picks?: string[];
  sources?: SourceId[];
  /** Include a listing-search step when the pipeline reports a query count. */
  queryCount?: number | null;
  verdict?: string | null;
  confidence?: string | null;
  creditsCharged?: number;
  failureReasons?: FailureReasonId[];
  /** True when this update is the end of the pipeline (verdict or an honest stop). */
  terminal?: boolean;
  at?: string;
};

const RUN_ID = /^run_[a-z0-9]{16,32}$/;

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

export function newRunId(): string {
  const hex = crypto.randomUUID().replace(/-/g, "");
  return `run_${hex.slice(0, 20)}`;
}

function nowIso(at?: string): string {
  return at ?? new Date().toISOString();
}

function readStep(step: JournalStepId, status: StepStatus, at: string, extra?: Partial<RunStep>): RunStep {
  return {
    step,
    status,
    responseId: extra?.responseId ?? null,
    model: extra?.model ?? null,
    startedAt: extra?.startedAt ?? at,
    finishedAt: extra?.finishedAt ?? at,
    elapsedMs: extra?.elapsedMs ?? null,
    failureReason: extra?.failureReason ?? null,
  };
}

export function createRun(input: {
  id?: string;
  ownerId: string;
  kind: RunKind;
  inputs: RunInputs;
  at?: string;
}): RunRecord {
  const at = nowIso(input.at);
  const id = input.id && isRunId(input.id) ? input.id : newRunId();
  const steps = [readStep("read_request", "ok", at)];
  const spec = specFor(input.inputs);
  const record: RunRecord = {
    v: 1,
    id,
    kind: input.kind,
    ownerId: input.ownerId,
    createdAt: at,
    updatedAt: at,
    phase: "running",
    inputs: cloneInputs(input.inputs),
    spec,
    steps,
    sources: [],
    listings: [],
    picks: [],
    verdict: null,
    confidence: null,
    creditsCharged: 0,
    failureReasons: [],
    progress: [
      {
        at,
        phase: "running",
        listingVins: [],
        pickVin: null,
        verdict: null,
        confidence: null,
        creditsCharged: 0,
        failureReasons: [],
        steps: ["read_request"],
      },
    ],
  };
  return record;
}

function cloneInputs(inputs: RunInputs): RunInputs {
  return {
    note: inputs.note,
    clarifications: [...inputs.clarifications],
    mode: inputs.mode,
    vin: inputs.vin,
    formEdits: inputs.formEdits ? { ...inputs.formEdits } : null,
  };
}

export function specFor(inputs: RunInputs): SearchSpec {
  const note = [inputs.note, ...inputs.clarifications].filter((line) => line.trim()).join("\n");
  return buildSearchSpec({
    note,
    mode: inputs.mode,
    formEdits: inputs.formEdits ?? undefined,
  });
}

function statusOf(value: string | null | undefined): StepStatus {
  if (value === "ok" || value === "failed" || value === "skipped" || value === "running") return value;
  if (value === "error" || value === "timeout") return "failed";
  return "skipped";
}

function failureFor(step: JournalStepId, status: StepStatus): FailureReasonId | null {
  if (status !== "failed") return null;
  if (step === "plan_search") return "could_not_plan";
  if (step === "choose_car") return "decision_failed";
  if (step === "second_check") return "second_check_incomplete";
  if (step === "search_listings") return "search_failed";
  return "not_enough_evidence";
}

function mergeStep(steps: RunStep[], next: RunStep): RunStep[] {
  const prior = steps.find((row) => row.step === next.step);
  if (!prior) return [...steps, next];
  const rank: Record<StepStatus, number> = { failed: 3, running: 2, ok: 1, skipped: 0 };
  const winner = rank[next.status] >= rank[prior.status] ? next : prior;
  return steps.map((row) =>
    row.step !== next.step
      ? row
      : {
          ...winner,
          responseId: next.responseId ?? prior.responseId,
          model: next.model ?? prior.model,
          elapsedMs: next.elapsedMs ?? prior.elapsedMs,
          failureReason: winner.failureReason ?? prior.failureReason,
        },
  );
}

function stepsFromProofs(proofs: ProofObservation[], at: string): RunStep[] {
  const out: RunStep[] = [];
  for (const proof of proofs) {
    const step = journalStepForPurpose(proof.purpose);
    if (!step) continue;
    const status = statusOf(proof.status);
    out.push(
      readStep(step, status, proof.timestamp ?? at, {
        responseId: proof.responseId ?? null,
        model: proof.model ?? null,
        elapsedMs: typeof proof.elapsedMs === "number" ? proof.elapsedMs : null,
        startedAt: proof.timestamp ?? at,
        finishedAt: proof.timestamp ?? at,
        failureReason: failureFor(step, status),
      }),
    );
  }
  return out.reduce(mergeStep, [] as RunStep[]);
}

function uniqueReasons(ids: FailureReasonId[]): FailureReasonId[] {
  const seen = new Set<FailureReasonId>();
  const out: FailureReasonId[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Apply one pipeline update.
 * The snapshot stored in `progress` is the run before this decision.
 * The record's verdict, charge, and phase are that snapshot plus the decision.
 */
export function applyObservation(run: RunRecord, observation: RunObservation): RunRecord {
  const at = nowIso(observation.at);
  const inputs = cloneInputs(run.inputs);
  if (typeof observation.note === "string" && observation.note.trim()) inputs.note = observation.note.trim();
  if (observation.clarifications) {
    for (const line of observation.clarifications) {
      const text = line.trim();
      if (text && !inputs.clarifications.includes(text)) inputs.clarifications.push(text);
    }
  }
  if (observation.formEdits) inputs.formEdits = { ...inputs.formEdits, ...observation.formEdits };
  if (observation.vin !== undefined) inputs.vin = observation.vin;

  let steps = run.steps.map((step) => ({ ...step }));
  for (const step of stepsFromProofs(observation.proofs ?? [], at)) steps = mergeStep(steps, step);
  if (observation.queryCount != null) {
    const searched = observation.queryCount > 0;
    steps = mergeStep(
      steps,
      readStep(searched ? "search_listings" : "search_listings", searched ? "ok" : "skipped", at, {
        failureReason: searched ? null : "no_cars",
      }),
    );
  }

  const listings = observation.listings ?? run.listings.map((row) => ({ ...row }));
  const picks = observation.picks ?? [...run.picks];
  const sources = [...run.sources];
  for (const source of observation.sources ?? []) {
    if (!sources.includes(source)) sources.push(source);
  }
  if ((observation.queryCount ?? 0) > 0 && !sources.includes("cars_for_sale")) sources.unshift("cars_for_sale");
  if (listings.length > 1 && !sources.includes("similar_cars")) sources.push("similar_cars");

  const spec = observation.spec ?? specFor(inputs);
  const searchKind = run.kind === "find" || run.kind === "resale";
  const emptyPool = listings.length === 0 && (observation.terminal === true || (searchKind && observation.queryCount != null));

  const requestedVerdict = verdictIdFromRaw(observation.verdict);
  const requestedConfidence = confidenceFromRaw(observation.confidence);
  const critical = steps.some((step) => (step.step === "plan_search" || step.step === "choose_car") && step.status === "failed");
  const secondFailed = steps.some((step) => step.step === "second_check" && step.status === "failed");

  const reasons = uniqueReasons([...(observation.failureReasons ?? []), ...steps.flatMap((step) => (step.failureReason ? [step.failureReason] : []))]);

  let decision: RunDecision;
  if (emptyPool) {
    decision = {
      phase: "stopped",
      verdict: null,
      confidence: null,
      creditsCharged: 0,
      failureReasons: uniqueReasons([...reasons, "no_cars"]),
    };
  } else if (critical && observation.terminal === true) {
    const charged = listings.length === 0 ? 0 : Math.max(0, observation.creditsCharged ?? run.creditsCharged);
    decision = {
      phase: "stopped",
      verdict: null,
      confidence: null,
      creditsCharged: charged,
      failureReasons: reasons.length ? reasons : ["decision_failed"],
    };
  } else if (observation.terminal === true) {
    const verdict = listings.length === 0 ? null : requestedVerdict;
    const charged = Math.max(0, observation.creditsCharged ?? run.creditsCharged);
    decision = {
      phase: verdict ? "finished" : "stopped",
      verdict,
      confidence: verdict ? (secondFailed ? "Low" : requestedConfidence) : null,
      creditsCharged: listings.length === 0 ? 0 : charged,
      failureReasons: uniqueReasons([
        ...reasons,
        ...(verdict ? [] : listings.length === 0 ? (["no_cars"] as const) : (["not_enough_evidence"] as const)),
        ...(secondFailed ? (["second_check_incomplete"] as const) : []),
      ]),
    };
  } else {
    decision = {
      phase: "running",
      verdict: null,
      confidence: null,
      creditsCharged: Math.max(0, observation.creditsCharged ?? 0),
      failureReasons: reasons.filter((id): id is FailureReasonId => id !== "no_cars" || listings.length === 0),
    };
  }

  if (decision.verdict && listings.length === 0) {
    decision = {
      ...decision,
      verdict: null,
      confidence: null,
      creditsCharged: 0,
      phase: "stopped",
      failureReasons: uniqueReasons([...decision.failureReasons, "no_cars"]),
    };
  }

  const snapshot: RunProgress = {
    at,
    phase: "running",
    listingVins: listings.map((car) => car.vin),
    pickVin: picks[0] ?? null,
    verdict: null,
    confidence: null,
    creditsCharged: 0,
    failureReasons: [],
    steps: steps.map((step) => step.step),
  };

  return {
    ...run,
    updatedAt: at,
    inputs,
    spec,
    steps,
    sources,
    listings,
    picks,
    phase: decision.phase,
    verdict: decision.verdict,
    confidence: decision.confidence,
    creditsCharged: decision.creditsCharged,
    failureReasons: decision.failureReasons,
    progress: [...run.progress, snapshot],
  };
}

/** Last in-progress snapshot, plus the decision stored on the run, equals the run. */
export function progressPlusDecision(progress: RunProgress, decision: RunDecision) {
  return { ...progress, ...decision };
}

export function finalMatchesLastProgress(run: RunRecord): boolean {
  const last = run.progress.at(-1);
  if (!last) return false;
  if (last.verdict !== null || last.confidence !== null || last.creditsCharged !== 0) return false;
  if (last.phase !== "running") return false;
  if (last.listingVins.join("|") !== run.listings.map((car) => car.vin).join("|")) return false;
  if (last.pickVin !== (run.picks[0] ?? null)) return false;
  const projected = progressPlusDecision(last, {
    phase: run.phase,
    verdict: run.verdict,
    confidence: run.confidence,
    creditsCharged: run.creditsCharged,
    failureReasons: run.failureReasons,
  });
  return (
    projected.phase === run.phase &&
    projected.verdict === run.verdict &&
    projected.confidence === run.confidence &&
    projected.creditsCharged === run.creditsCharged &&
    JSON.stringify(projected.failureReasons) === JSON.stringify(run.failureReasons) &&
    projected.listingVins.join("|") === run.listings.map((car) => car.vin).join("|")
  );
}

export function appendClarification(run: RunRecord, text: string, formEdits?: SearchFormEdits | null, at?: string): RunRecord {
  const line = text.trim();
  if (!line) return run;
  const inputs = cloneInputs(run.inputs);
  if (!inputs.clarifications.includes(line)) inputs.clarifications.push(line);
  if (formEdits) inputs.formEdits = { ...inputs.formEdits, ...formEdits };
  return {
    ...run,
    inputs,
    spec: specFor(inputs),
    updatedAt: nowIso(at),
  };
}

function limitSentences(spec: SearchSpec | null): string[] {
  if (!spec) return [];
  const lines: string[] = [];
  const price = spec.hard.priceMaxUsd?.value;
  if (price != null) lines.push(`Budget up to ${formatUsd(price)}.`);
  const yearMin = spec.hard.yearMin?.value;
  const yearMax = spec.hard.yearMax?.value;
  if (yearMin != null && yearMax != null) lines.push(`Years ${yearMin} through ${yearMax}.`);
  else if (yearMin != null) lines.push(`Oldest year ${yearMin}.`);
  else if (yearMax != null) lines.push(`Newest year ${yearMax}.`);
  const miles = spec.hard.milesMax?.value;
  if (miles != null) lines.push(`No more than ${formatNumber(miles)} miles.`);
  const zip = spec.hard.zip?.value;
  const radius = spec.hard.radiusMi?.value;
  if (radius === null) lines.push("Nationwide.");
  else if (zip && radius != null) lines.push(`Within ${formatNumber(radius)} miles of ${zip}.`);
  else if (zip) lines.push(`Near ${zip}.`);
  if (spec.hard.drivetrain?.value === "awd_4wd") lines.push("All-wheel drive or four-wheel drive.");
  const excluded = spec.hard.excludeMakes?.value ?? [];
  if (excluded.length) lines.push(`Not ${excluded.join(" or ")}.`);
  return lines;
}

export function toRunView(run: RunRecord, viewerId: string | null): RunView {
  return {
    id: run.id,
    kind: run.kind,
    phase: run.phase,
    viewerIsOwner: Boolean(viewerId && viewerId === run.ownerId),
    permalink: `/run/${run.id}`,
    note: run.inputs.note,
    clarifications: [...run.inputs.clarifications],
    limits: limitSentences(run.spec),
    verdict: run.verdict,
    confidence: run.confidence,
    creditsCharged: run.creditsCharged,
    failureReasons: [...run.failureReasons],
    steps: run.steps.map((step) => ({
      step: step.step,
      status: step.status,
      responseId: step.responseId,
      elapsedMs: step.elapsedMs,
    })),
    sources: [...run.sources],
    listings: run.listings.map((car) => ({ ...car })),
    picks: [...run.picks],
  };
}

export function parseRunRecord(raw: string): RunRecord | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Partial<RunRecord>;
    if (row.v !== 1 || typeof row.id !== "string" || !isRunId(row.id)) return null;
    if (row.kind !== "find" && row.kind !== "resale" && row.kind !== "check") return null;
    if (typeof row.ownerId !== "string" || !row.ownerId) return null;
    if (!row.inputs || typeof row.inputs !== "object") return null;
    if (!Array.isArray(row.steps) || !Array.isArray(row.listings) || !Array.isArray(row.progress)) return null;
    const failureReasons = Array.isArray(row.failureReasons) ? row.failureReasons.filter((id): id is FailureReasonId => typeof id === "string" && isFailureReasonId(id)) : [];
    const sources = Array.isArray(row.sources) ? row.sources.filter((id): id is SourceId => typeof id === "string" && isSourceId(id)) : [];
    const steps = row.steps.filter((step): step is RunStep => Boolean(step) && typeof step === "object" && isJournalStepId(String((step as RunStep).step)));
    return {
      v: 1,
      id: row.id,
      kind: row.kind,
      ownerId: row.ownerId,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date(0).toISOString(),
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : new Date(0).toISOString(),
      phase: row.phase === "draft" || row.phase === "running" || row.phase === "finished" || row.phase === "stopped" ? row.phase : "running",
      inputs: {
        note: typeof row.inputs.note === "string" ? row.inputs.note : "",
        clarifications: Array.isArray(row.inputs.clarifications) ? row.inputs.clarifications.filter((line): line is string => typeof line === "string") : [],
        mode: row.inputs.mode === "flip" ? "flip" : "personal",
        vin: typeof row.inputs.vin === "string" ? row.inputs.vin : null,
        formEdits: row.inputs.formEdits ?? null,
      },
      spec: row.spec && typeof row.spec === "object" ? (row.spec as SearchSpec) : null,
      steps,
      sources,
      listings: row.listings.filter((car): car is RunListing => Boolean(car) && typeof car === "object" && typeof (car as RunListing).vin === "string"),
      picks: Array.isArray(row.picks) ? row.picks.filter((vin): vin is string => typeof vin === "string") : [],
      verdict: typeof row.verdict === "string" ? verdictIdFromRaw(row.verdict) : null,
      confidence: row.confidence === "High" || row.confidence === "Medium" || row.confidence === "Low" ? row.confidence : null,
      creditsCharged: typeof row.creditsCharged === "number" && row.creditsCharged > 0 ? Math.round(row.creditsCharged) : 0,
      failureReasons,
      progress: row.progress.filter((item): item is RunProgress => Boolean(item) && typeof item === "object"),
    };
  } catch {
    return null;
  }
}
