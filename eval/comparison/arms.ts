/**
 * Three comparison arms on the SAME captured inputs.
 *
 * Offline: only pure-code arms (cheapest, Lemonless deterministic domain modules).
 * plain_llm is always `not_run` offline — never canned prose.
 *
 * Live: Lemonless uses selectBestDealOnEvidence or the captured Check listing,
 * then the production report path (verdict_decide + verdict_challenge).
 * plain_llm gets one chat completion on the identical shared payload.
 */
import { listingRedFlags } from "@/domain/listing/red-flags";
import type { ExtractedListingFields } from "@/domain/listing/types";
import { selectBestDealOnEvidence } from "@/domain/find-best-deal";
import { explicitNeedFromText } from "@/domain/need";
import { evaluateListingPrice } from "@/domain/price-evaluation";
import { buildComputedReport } from "@/domain/report";
import type { ComputedReport, Listing } from "@/domain/types";
import { resolveVerdictDecision, verdictDecisionFacts } from "@/domain/verdict-decide";
import type { MandateInput } from "@/domain/verdict-gates";
import { runReportVerdictChallenge } from "@/server/agent-second-pass";
import { BASE_MODEL, runServ } from "@/server/serv";
import { bandFromAskVsFair } from "./score";
import type {
  ArmOutput,
  CapturedListing,
  CheckCaseFixture,
  FindCaseFixture,
  LiveModelTrace,
  PlainLlmParsed,
  PriceBand,
} from "./types";

export function sharedModelId(): string {
  return process.env.SERV_MODEL?.trim() || BASE_MODEL;
}

export function liveAllowed(): boolean {
  if (process.env.COMPARISON_DRY_RUN === "1") return false;
  return process.env.COMPARISON_ALLOW_PAID === "1" && Boolean(process.env.SERV_API_KEY?.trim());
}

/** Shared payload both Lemonless (facts) and plain_llm (prompt) see. */
export function sharedFindPayload(fixture: FindCaseFixture) {
  return {
    kind: "find" as const,
    query: fixture.query,
    zip: fixture.zip,
    budgetUsd: fixture.budgetUsd,
    listings: fixture.listings,
    comps: fixture.comps,
  };
}

export function sharedCheckPayload(fixture: CheckCaseFixture) {
  return {
    kind: "check" as const,
    rawText: fixture.rawText,
    subject: fixture.subject,
    comps: fixture.comps,
  };
}

export function toListing(row: CapturedListing): Listing {
  return {
    vin: row.vin ?? `NOVIN${row.year}${row.make}${row.model}`.replace(/[^A-Z0-9]/gi, "").slice(0, 17).toUpperCase().padEnd(17, "0"),
    year: row.year,
    make: row.make,
    model: row.model,
    trim: row.trim,
    priceUsd: row.priceUsd,
    miles: row.miles,
    city: row.city ?? null,
    state: row.state ?? null,
    zip: null,
    vdp: row.sourceUrl ?? null,
    dealer: null,
    source: "sample",
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: null,
    ownerCount: null,
    oneOwner: null,
    usageType: null,
    createdAt: null,
    engine: null,
    drivetrain: null,
    fuel: null,
    bodyStyle: null,
    latitude: null,
    longitude: null,
    removedAt: null,
  };
}

function emptyFields(subject: CapturedListing): ExtractedListingFields {
  const cell = <T,>(value: T | null) => ({ value, source: "visible_text" as const });
  return {
    year: cell(subject.year),
    make: cell(subject.make),
    model: cell(subject.model),
    trim: cell(subject.trim),
    priceUsd: cell(subject.priceUsd),
    miles: cell(subject.miles),
    vin: cell(subject.vin),
    titleStatus: cell(subject.titleStatus ?? (subject.availability === "sold" ? "SOLD" : null)),
    accidentsStated: cell(null),
    description: cell(subject.description ?? null),
    drivetrain: cell(null),
    fuel: cell(null),
    transmission: cell(null),
    color: cell(null),
    location: cell(null),
    zip: cell(null),
    state: cell(subject.state ?? null),
    sellerName: cell(null),
    listingDate: cell(null),
    photoCount: cell(null),
    ownersStated: cell(null),
    features: cell(null),
  };
}

function soldFlag(subject: CapturedListing, rawText: string): string[] {
  if (subject.availability === "sold" || /\bSOLD\b/i.test(rawText) || /schema\.org\/SoldOut/i.test(rawText)) {
    return ["sold"];
  }
  return [];
}

function missingVinFlag(subject: CapturedListing, rawText: string): string[] {
  if (!subject.vin || /VIN\s*(N\/?A|not available|unavailable|upon request)/i.test(rawText)) {
    return ["missing_vin"];
  }
  return [];
}

function recallFlag(rawText: string): string[] {
  if (/\brecall\b/i.test(rawText)) return ["recall"];
  return [];
}

function notRunPlain(reason: string): ArmOutput {
  return {
    arm: "plain_llm",
    status: "not_run",
    reasonNotRun: reason,
    pickVin: null,
    priceVerdict: "unknown",
    fairValueUsd: null,
    redFlags: [],
    unknowns: [],
    summary: reason,
    latencyMs: 0,
    costUsd: null,
    model: null,
    textForNumbers: "",
    liveTrace: null,
  };
}

export function runCheapestFind(fixture: FindCaseFixture): ArmOutput {
  const started = Date.now();
  const ranked = [...fixture.listings].sort((a, b) => a.priceUsd - b.priceUsd);
  const pick = ranked[0] ?? null;
  const pool = [...fixture.listings, ...fixture.comps].map(toListing);
  const fair =
    pick != null
      ? evaluateListingPrice(toListing(pick), pool).fairValueUsd
      : null;
  const summary = pick
    ? `Cheapest ask: ${pick.year} ${pick.make} ${pick.model} at $${pick.priceUsd}.`
    : "No listings.";
  return {
    arm: "cheapest",
    status: "ran",
    pickVin: pick?.vin ?? null,
    priceVerdict: bandFromAskVsFair(pick?.priceUsd ?? null, fair),
    fairValueUsd: fair,
    redFlags: pick ? [...soldFlag(pick, pick.description ?? ""), ...missingVinFlag(pick, pick.description ?? "")] : [],
    unknowns: ["Cheapest sort does not inspect title, recalls, or condition."],
    summary,
    latencyMs: Date.now() - started,
    costUsd: 0,
    model: null,
    textForNumbers: [
      `prices ${fixture.listings.map((r) => r.priceUsd).join(" ")}`,
      `miles ${fixture.listings.map((r) => r.miles).join(" ")}`,
      `years ${fixture.listings.map((r) => r.year).join(" ")}`,
    ].join(" | "),
  };
}

export function runCheapestCheck(fixture: CheckCaseFixture): ArmOutput {
  const started = Date.now();
  const ask = fixture.subject.priceUsd;
  const fair = evaluateListingPrice(
    toListing(fixture.subject),
    fixture.comps.length ? fixture.comps.map(toListing) : [toListing(fixture.subject)],
  ).fairValueUsd;
  const summary = `Cheapest-price arm on a single listing: ask $${ask}.`;
  return {
    arm: "cheapest",
    status: "ran",
    pickVin: fixture.subject.vin,
    priceVerdict: bandFromAskVsFair(ask, fair),
    fairValueUsd: fair,
    redFlags: [],
    unknowns: ["Single-listing cheapest arm does not scan red-flag language."],
    summary,
    latencyMs: Date.now() - started,
    costUsd: 0,
    model: null,
    textForNumbers: [
      `ask ${ask}`,
      `year ${fixture.subject.year}`,
      `miles ${fixture.subject.miles}`,
      `compPrices ${fixture.comps.map((c) => c.priceUsd).join(" ")}`,
      fixture.rawText,
    ].join(" | "),
  };
}

/**
 * Offline Lemonless Find — production ranking module only (no SERV, no labels).
 */
export function runLemonlessFindDeterministic(fixture: FindCaseFixture): ArmOutput {
  const started = Date.now();
  const parsed = explicitNeedFromText(fixture.query, "personal");
  const need = {
    ...parsed,
    budgetKnown: fixture.budgetUsd != null,
    budgetUsd: fixture.budgetUsd,
    zip: fixture.zip,
    note: fixture.query,
  };
  const usable = fixture.listings.filter((row) => row.availability !== "sold");
  const listings = usable.map(toListing);
  const pool = [...fixture.listings, ...fixture.comps].map(toListing);
  const result = selectBestDealOnEvidence({
    need,
    listings,
    marketPool: pool,
    nowYear: 2026,
  });
  const pickKey = result.pick?.vin ?? result.pick?.key ?? null;
  const pickListing = listings.find((row) => row.vin === pickKey) ?? null;
  const captured = fixture.listings.find((row) => row.vin === pickKey) ?? null;
  const evalPrice = pickListing != null ? evaluateListingPrice(pickListing, pool) : null;
  const fairValueUsd = evalPrice?.fairValueUsd ?? null;

  const flags = new Set<string>();
  for (const row of fixture.listings) {
    for (const id of soldFlag(row, row.description ?? "")) flags.add(id);
  }
  if (captured) {
    for (const id of soldFlag(captured, captured.description ?? "")) flags.add(id);
    for (const id of missingVinFlag(captured, captured.description ?? "")) flags.add(id);
    const red = listingRedFlags({
      fields: emptyFields(captured),
      description: captured.description,
      pageText: captured.description,
      subject: pickListing,
      compsPool: fixture.comps.map(toListing),
    });
    for (const flag of red) flags.add(flag.id);
  }

  const unknowns = [...result.stillUnknown.slice(0, 3)];
  if (!result.pick) unknowns.push("No usable pick after evidence ranking.");
  if (result.confidence === "low" || result.confidence === "none") {
    unknowns.push(`Confidence: ${result.confidence}`);
  }
  const pickLabel = result.pick ? `${result.pick.year} ${result.pick.make} ${result.pick.model}` : null;
  const summary = result.pick
    ? `Lemonless pick ${pickLabel} (${result.confidence}). ${result.settlementNote}`
    : `Lemonless withheld a pick. ${result.settlementNote}`;

  return {
    arm: "lemonless",
    status: "ran",
    pickVin: pickKey,
    priceVerdict: bandFromAskVsFair(pickListing?.priceUsd ?? null, fairValueUsd),
    fairValueUsd,
    redFlags: [...flags],
    unknowns,
    summary,
    latencyMs: Date.now() - started,
    costUsd: 0,
    model: null,
    textForNumbers: [
      `pick ${pickKey ?? "none"}`,
      `year ${result.pick?.year ?? ""}`,
      `prices ${fixture.listings.map((r) => r.priceUsd).join(" ")}`,
      `miles ${fixture.listings.map((r) => r.miles).join(" ")}`,
      `years ${fixture.listings.map((r) => r.year).join(" ")}`,
      `budget ${fixture.budgetUsd ?? "none"}`,
      `zip ${fixture.zip}`,
      fixture.query.replace(/\b(CX|CR|RAV|F|CT)-?\d+\b/gi, "MODEL"),
    ].join(" | "),
  };
}

/**
 * Offline Lemonless Check — production pricing + red-flag modules (no labels).
 */
export function runLemonlessCheckDeterministic(fixture: CheckCaseFixture): ArmOutput {
  const started = Date.now();
  const subject = toListing(fixture.subject);
  const pool = fixture.comps.map(toListing);
  const price = evaluateListingPrice(subject, pool.length ? pool : [subject]);
  const red = listingRedFlags({
    fields: emptyFields(fixture.subject),
    description: fixture.subject.description,
    pageText: fixture.rawText,
    subject,
    compsPool: pool,
  });
  const flags = [
    ...soldFlag(fixture.subject, fixture.rawText),
    ...missingVinFlag(fixture.subject, fixture.rawText),
    ...recallFlag(fixture.rawText),
    ...red.map((f) => f.id),
  ];
  const unknowns = [
    ...(fixture.subject.vin ? [] : ["VIN missing from listing"]),
    ...(price.fairValueUsd == null ? ["Fair value not established"] : []),
  ];
  const walk =
    flags.includes("sold") || flags.includes("title_brand")
      ? "Walk away until title/availability is cleared."
      : flags.includes("missing_vin")
        ? "Do not buy without a VIN decode and history."
        : price.priced
          ? `Price reading: ${price.label}.`
          : "Price reading incomplete.";
  const summary = `${fixture.subject.year} ${fixture.subject.make} ${fixture.subject.model} ask $${fixture.subject.priceUsd}. ${walk}`;

  return {
    arm: "lemonless",
    status: "ran",
    pickVin: flags.includes("sold") ? null : fixture.subject.vin,
    priceVerdict: flags.includes("sold") ? "unknown" : bandFromAskVsFair(fixture.subject.priceUsd, price.fairValueUsd),
    fairValueUsd: price.fairValueUsd,
    redFlags: flags,
    unknowns,
    summary,
    latencyMs: Date.now() - started,
    costUsd: 0,
    model: null,
    textForNumbers: [
      `ask ${fixture.subject.priceUsd}`,
      `year ${fixture.subject.year}`,
      `miles ${fixture.subject.miles}`,
      `compPrices ${fixture.comps.map((c) => c.priceUsd).join(" ")}`,
      fixture.rawText,
    ].join(" | "),
  };
}

export function runPlainOfflineFind(_fixture: FindCaseFixture): ArmOutput {
  return notRunPlain(
    "plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.",
  );
}

export function runPlainOfflineCheck(_fixture: CheckCaseFixture): ArmOutput {
  return notRunPlain(
    "plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.",
  );
}

function computedFromCaptured(subject: Listing, pool: Listing[]): ComputedReport {
  return buildComputedReport({
    mode: "personal",
    subject,
    candidates: pool.length > 0 ? pool : [subject],
    recalls: [],
    recallsAvailable: false,
    complaintCount: null,
    fuel: null,
    vinDecode: null,
    distanceToSearchZipMiles: null,
    checkedAt: "2026-11-09T00:00:00.000Z",
    externalLookupsPerformed: false,
    sample: true,
  });
}

/**
 * Same decide → guardrail → challenge sequence as assembleReport.
 * userLookup is the shared listing payload. Scoring labels are not included.
 * Facts are verdictDecisionFacts — code numbers and gates, not a custom prompt.
 */
async function applyProductionVerdict(input: {
  report: ComputedReport;
  userLookup: string;
  mandate: MandateInput;
}): Promise<{
  action: string;
  source: string;
  called: boolean;
  ok: boolean;
  trace: LiveModelTrace | null;
  challengeStatus: string;
}> {
  const mandate = input.mandate;
  const preview = resolveVerdictDecision({
    report: input.report,
    servText: null,
    servOk: false,
    hasServKey: false,
    mandate,
  });
  if (preview.gateRun.withheld || !liveAllowed()) {
    return {
      action: preview.finalAction,
      source: preview.source,
      called: false,
      ok: false,
      trace: null,
      challengeStatus: "not_run",
    };
  }

  const model = sharedModelId();
  const timestamp = new Date().toISOString();
  const facts = verdictDecisionFacts(input.report, mandate);
  const user = JSON.stringify({ facts, userLookup: input.userLookup });
  const deps = {
    fetch,
    apiKey: process.env.SERV_API_KEY,
    baseUrl: process.env.SERV_BASE_URL,
    model,
  };
  const judged = await runServ("verdict_decide", { user }, deps);
  const decision = resolveVerdictDecision({
    report: input.report,
    servText: judged.ok ? judged.text : null,
    servOk: judged.ok,
    hasServKey: true,
    mandate,
  });
  const primary =
    decision.finalAction === "withheld"
      ? null
      : (decision.finalAction as Exclude<typeof decision.finalAction, "withheld">);
  const confidence = decision.source === "serv" && decision.overrideReasons.length === 0 ? "high" : "medium";
  const challenge =
    decision.finalAction === "withheld"
      ? { result: { status: "not_run" as const }, proof: null, rawText: null }
      : await runReportVerdictChallenge({
          report: input.report,
          primaryAction: primary,
          confidence,
          allowedActions: decision.allowedActions.filter(
            (action): action is Exclude<typeof action, "withheld"> => action !== "withheld",
          ),
          hasBudget: true,
          servKey: process.env.SERV_API_KEY,
          servBaseUrl: process.env.SERV_BASE_URL,
          model,
          fetchImpl: fetch,
        });
  const decideRaw = judged.ok ? judged.text : `verdict_decide failed: ${"error" in judged ? judged.error : "unknown"}`;
  const challengeRaw = challenge.rawText ?? "";
  return {
    action: decision.finalAction,
    source: decision.source,
    called: true,
    ok: judged.ok,
    challengeStatus: challenge.result.status,
    trace: {
      model,
      timestamp,
      prompt: user,
      rawResponse: challengeRaw ? `${decideRaw}\n--- verdict_challenge ---\n${challengeRaw}` : decideRaw,
      openservResponseId: judged.proof.openserv?.id ?? null,
      challengeResponseId: challenge.proof?.openserv?.id ?? null,
    },
  };
}

function applyServAction(base: ArmOutput, action: string): ArmOutput {
  if (action === "pass" || action === "withheld") {
    return { ...base, pickVin: null, priceVerdict: action === "withheld" ? "unknown" : base.priceVerdict };
  }
  return base;
}

/**
 * Live Lemonless Find: production ranking, then the report verdict pipeline
 * on that pick. No call unless COMPARISON_ALLOW_PAID=1 and SERV_API_KEY are set.
 */
export async function runLemonlessFindLive(fixture: FindCaseFixture): Promise<ArmOutput> {
  const base = runLemonlessFindDeterministic(fixture);
  if (!liveAllowed()) return base;
  const pick = fixture.listings.find((row) => row.vin === base.pickVin);
  if (!pick) {
    return { ...base, unknowns: [...base.unknowns, "No pick to send through verdict_decide."] };
  }
  const pool = [...fixture.listings, ...fixture.comps].map(toListing);
  const report = computedFromCaptured(toListing(pick), pool);
  const started = Date.now();
  const serv = await applyProductionVerdict({
    report,
    userLookup: JSON.stringify(sharedFindPayload(fixture)),
    mandate: {
      budgetUsd: fixture.budgetUsd,
      budgetKnown: fixture.budgetUsd != null,
      targetProfitUsd: null,
      repairAbility: "unknown",
    },
  });
  const next = applyServAction(base, serv.action);
  return {
    ...next,
    summary: `${base.summary} Production verdict ${serv.action} (${serv.source}). Second check: ${serv.challengeStatus}.`,
    latencyMs: base.latencyMs + (Date.now() - started),
    costUsd: serv.called ? null : 0,
    model: serv.called ? sharedModelId() : null,
    liveTrace: serv.trace,
    unknowns: serv.called && !serv.ok ? [...next.unknowns, "SERV call failed"] : next.unknowns,
  };
}

/**
 * Live Lemonless Check: same captured subject and comps as plain_llm,
 * then production verdict_decide + verdict_challenge on those captured rows.
 */
export async function runLemonlessCheckLive(fixture: CheckCaseFixture): Promise<ArmOutput> {
  const base = runLemonlessCheckDeterministic(fixture);
  if (!liveAllowed()) return base;
  const subject = toListing(fixture.subject);
  const pool = [subject, ...fixture.comps.map(toListing)];
  const report = computedFromCaptured(subject, pool);
  const started = Date.now();
  const serv = await applyProductionVerdict({
    report,
    userLookup: JSON.stringify(sharedCheckPayload(fixture)),
    mandate: { budgetUsd: null, budgetKnown: false, targetProfitUsd: null, repairAbility: "unknown" },
  });
  const next = applyServAction(base, serv.action);
  return {
    ...next,
    summary: `${base.summary} Production verdict ${serv.action} (${serv.source}). Second check: ${serv.challengeStatus}.`,
    latencyMs: base.latencyMs + (Date.now() - started),
    costUsd: serv.called ? null : 0,
    model: serv.called ? sharedModelId() : null,
    liveTrace: serv.trace,
    unknowns: serv.called && !serv.ok ? [...next.unknowns, "SERV call failed"] : next.unknowns,
  };
}

/** Test aliases — offline deterministic path. */
export const runLemonlessFind = runLemonlessFindDeterministic;
export const runLemonlessCheck = runLemonlessCheckDeterministic;

export async function runPlainLiveFind(fixture: FindCaseFixture): Promise<ArmOutput> {
  const payload = sharedFindPayload(fixture);
  const prompt = [
    "You are a used-car shopping assistant. Given this Find payload (identical to what Lemonless ranked),",
    "pick ONE vin, state priceVerdict (far_below|below|fair|above|far_above|unknown), optional fairValueUsd,",
    "redFlags, unknowns, and a one-sentence summary. Reply JSON only:",
    "{pickVin,priceVerdict,fairValueUsd,redFlags,unknowns,summary}",
    "Do not invent VINs or dollar figures absent from the payload.",
    `Shared payload:\n${JSON.stringify(payload)}`,
  ].join("\n");
  return callPlainLlm(prompt);
}

export async function runPlainLiveCheck(fixture: CheckCaseFixture): Promise<ArmOutput> {
  const payload = sharedCheckPayload(fixture);
  const prompt = [
    "You are a used-car listing checker. Given this Check payload (identical to what Lemonless scored),",
    "decide if it is buyable. Reply JSON only:",
    "{pickVin,priceVerdict,fairValueUsd,redFlags,unknowns,summary}",
    "priceVerdict one of far_below|below|fair|above|far_above|unknown.",
    "Include sold/salvage/missing_vin/recall in redFlags when present. Do not invent figures.",
    `Shared payload:\n${JSON.stringify(payload)}`,
  ].join("\n");
  return callPlainLlm(prompt);
}

async function callPlainLlm(prompt: string): Promise<ArmOutput> {
  const key = process.env.SERV_API_KEY?.trim();
  if (!key) return notRunPlain("SERV_API_KEY required for live plain LLM");
  const model = sharedModelId();
  const started = Date.now();
  const timestamp = new Date().toISOString();
  const base = (process.env.SERV_BASE_URL || "https://inference-api.openserv.ai/v1").replace(/\/$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: "system",
          content: "Return only compact JSON. Never invent VINs or dollar figures that are not in the user payload.",
        },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const raw = payload?.choices?.[0]?.message?.content?.trim() ?? "";
  const parsed = parsePlainJson(raw);
  const text = `${parsed.summary} fairValueUsd=${parsed.fairValueUsd ?? ""} verdict=${parsed.priceVerdict} flags=${parsed.redFlags.join(",")}`;
  const trace: LiveModelTrace = { model, timestamp, prompt, rawResponse: raw };
  return {
    arm: "plain_llm",
    status: "ran",
    pickVin: parsed.pickVin,
    priceVerdict: parsed.priceVerdict,
    fairValueUsd: parsed.fairValueUsd,
    redFlags: parsed.redFlags,
    unknowns: parsed.unknowns,
    summary: parsed.summary,
    latencyMs: Date.now() - started,
    costUsd: null,
    model,
    textForNumbers: text,
    liveTrace: trace,
  };
}

function parsePlainJson(text: string): PlainLlmParsed {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      pickVin: null,
      priceVerdict: "unknown",
      fairValueUsd: null,
      redFlags: [],
      unknowns: ["plain_llm_parse_failed"],
      summary: text.slice(0, 200) || "Empty plain LLM response",
    };
  }
  try {
    const parsed = JSON.parse(match[0]) as Partial<PlainLlmParsed>;
    const okBand: PriceBand[] = ["far_below", "below", "fair", "above", "far_above", "unknown"];
    const band = parsed.priceVerdict;
    return {
      pickVin: typeof parsed.pickVin === "string" ? parsed.pickVin : null,
      priceVerdict: okBand.includes(band as PriceBand) ? (band as PriceBand) : "unknown",
      fairValueUsd: typeof parsed.fairValueUsd === "number" ? parsed.fairValueUsd : null,
      redFlags: Array.isArray(parsed.redFlags) ? parsed.redFlags.map(String) : [],
      unknowns: Array.isArray(parsed.unknowns) ? parsed.unknowns.map(String) : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : "No summary",
    };
  } catch {
    return {
      pickVin: null,
      priceVerdict: "unknown",
      fairValueUsd: null,
      redFlags: [],
      unknowns: ["plain_llm_json_invalid"],
      summary: text.slice(0, 200),
    };
  }
}
