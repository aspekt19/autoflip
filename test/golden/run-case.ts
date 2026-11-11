/**
 * Drives the real find / resale functions with an injected fetch.
 * The session mirrors the current client: a fresh note sends the previous
 * budget (AssistantFlow reads it from the render closure), and a year set on
 * Confirm updates the need without rebuilding plan directions.
 */
import { budgetFromText } from "@/domain/note-intake";
import { selectBestDealOnEvidence } from "@/domain/find-best-deal";
import type { SearchDirection } from "@/domain/directions";
import type { StructuredNeed } from "@/domain/need";
import { findDeliveryChargesCredit } from "@/domain/find-delivery";
import { sha256Canonical } from "@/domain/hash";
import { TtlCache } from "@/io/cache";
import { MemoryKv } from "@/io/kv";
import { MemoryCounter } from "@/io/quota";
import { parseUsdInput } from "@/domain/budget";
import type { FindPlan } from "@/domain/find-plan";
import { runFindDecideServ } from "@/server/find-decide-serv";
import { runFindMatch, type FindMatchResult } from "@/server/find-match";
import { runResaleSearch, type ResaleSearchResult } from "@/server/resale-search";
import { BASE_MODEL, profile } from "@/server/serv";
import { understandNeed } from "@/server/understand-need";
import type { GoldenCase, CaseTurn } from "./cases";
import { createGoldenFetch, listingSearchUrls, recordingsRoot, type GoldenMode, type TransportAttempt } from "./transport";
import type { GoldenRun, ObservedSpec, Prov, ShownListing, StepTiming } from "./types";

const DUMMY_KEY = "golden-offline";

type Spend = { maxServCalls: number; count: { n: number } };

function confidenceOf(raw: string | null | undefined): GoldenRun["confidence"] {
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (value === "high") return "High";
  if (value === "medium") return "Medium";
  if (value === "low" || value === "none") return "Low";
  return null;
}

function budgetSource(note: string, sent: number | null, pipeline: number | null): Prov {
  const fromNote = budgetFromText(note);
  if (sent != null && pipeline === sent && fromNote !== sent) return "form";
  if (fromNote != null && pipeline === fromNote) return "note";
  if (sent != null && pipeline === sent) return "form";
  return "default";
}

function isNote(turn: CaseTurn): turn is { note: string } {
  return "note" in turn;
}

class ClientSession {
  budget = "";
  budgetKnown = false;
  yearMinDraft = "";
  need: StructuredNeed | null = null;
  directions: SearchDirection[] = [];
  plan: FindPlan | null = null;
  idem: string | null = null;
  keys: string[] = [];
  replayed = false;
  private deliveries = new Map<string, FindMatchResult>();
  private seq = 0;

  constructor(private readonly mode: "personal" | "flip") {}

  async submit(note: string, fetchImpl: typeof fetch): Promise<{ sentBudget: number | null }> {
    const amount = parseUsdInput(this.budget);
    const sentBudget = this.budgetKnown && amount != null ? amount : null;
    const result = await understandNeed(
      {
        text: note,
        mode: this.mode,
        budgetUsd: sentBudget,
        budgetKnown: this.budgetKnown,
        zip: null,
        distanceMiles: null,
      },
      { fetchImpl, servKey: DUMMY_KEY, servModel: BASE_MODEL },
    );
    if (!result.ok) throw new Error(result.message);
    this.need = result.need;
    this.directions = result.directions;
    this.plan = result.findPlan;
    if (result.need.budgetUsd != null) {
      this.budget = result.need.budgetUsd.toLocaleString("en-US");
      this.budgetKnown = result.need.budgetKnown;
    }
    if (result.need.yearMin != null) this.yearMinDraft = String(result.need.yearMin);
    return { sentBudget };
  }

  confirm(form: { yearMin?: number; zip?: string | null; distanceMiles?: number | null }) {
    if (!this.need) throw new Error("Confirm before a plan.");
    if (form.yearMin != null) {
      this.yearMinDraft = String(form.yearMin);
      this.need = { ...this.need, yearMin: form.yearMin, yearBandResolved: true };
    }
    if (form.zip !== undefined || form.distanceMiles !== undefined) {
      this.need = {
        ...this.need,
        ...(form.zip !== undefined ? { zip: form.zip } : {}),
        ...(form.distanceMiles !== undefined ? { distanceMiles: form.distanceMiles } : {}),
      };
    }
  }

  spec(note: string, sentBudget: number | null, location: GoldenCase["location"]): ObservedSpec {
    if (!this.need) throw new Error("No need.");
    const need = this.need;
    const source = budgetSource(note, sentBudget, need.budgetUsd);
    const hard: ObservedSpec["hard"] = {};
    if (need.budgetKnown && need.budgetUsd != null) hard.priceMaxUsd = { value: need.budgetUsd, source };
    if (need.yearMin != null) hard.yearMin = { value: need.yearMin, source: this.yearMinDraft ? "form" : "note" };
    if (need.yearMax != null) hard.yearMax = { value: need.yearMax, source: "note" };
    if (need.milesMax != null) hard.milesMax = { value: need.milesMax, source: "note" };
    if (need.zip) {
      const fromNote = location === "from-note" || note.includes(need.zip);
      hard.zip = { value: need.zip, source: fromNote ? "note" : "form" };
    } else if (location === "nationwide") {
      hard.zip = { value: null, source: "form" };
    }
    hard.radiusMi = {
      value: need.distanceMiles,
      source: location === "from-note" ? "note" : "form",
    };
    const direction = this.directions[0];
    const enforced = {
      yearMin: direction?.yearMin ?? need.yearMin ?? null,
      yearMax: direction?.yearMax ?? need.yearMax ?? null,
      milesMax: need.milesMax,
      priceMaxUsd: need.budgetKnown ? need.budgetUsd : null,
      zip: need.zip,
      radiusMi: need.distanceMiles,
    };
    const draft = { v: 1 as const, mode: this.mode, note, hard, enforced };
    return { ...draft, hash: sha256Canonical(draft) };
  }

  async match(fetchImpl: typeof fetch): Promise<FindMatchResult> {
    if (!this.need) throw new Error("No need.");
    if (!this.idem) {
      this.seq += 1;
      this.idem = `find-golden-${this.seq}`;
    }
    const key = this.idem;
    this.keys.push(key);
    const cached = this.deliveries.get(key);
    if (cached) {
      this.replayed = true;
      return cached;
    }
    const yearMin = this.yearMinDraft ? Number(this.yearMinDraft) : this.need.yearMin ?? undefined;
    const result = await runFindMatch(
      {
        need: this.need,
        ...(this.directions.length > 0 ? { directions: this.directions } : {}),
        refine: { yearMin, yearMax: this.need.yearMax ?? undefined },
      },
      depsFor(fetchImpl),
    );
    if (result.ok) {
      this.deliveries.set(key, result);
      this.idem = null;
    }
    return result;
  }
}

function depsFor(fetchImpl: typeof fetch) {
  return {
    autodevKey: DUMMY_KEY,
    servKey: DUMMY_KEY,
    servModel: BASE_MODEL,
    fetch: fetchImpl,
    fetchImpl,
    autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
    kv: new MemoryKv(),
    env: {} as Record<string, string | undefined>,
  };
}

function shownFromMatch(result: FindMatchResult): ShownListing[] {
  if (!result.ok) return [];
  return result.body.directions.flatMap((group) =>
    group.listings.map((car) => ({
      vin: car.vin,
      year: car.year,
      make: car.make,
      model: car.model,
      priceUsd: car.priceUsd,
      miles: car.miles,
      distanceMiles: car.distanceMiles ?? null,
      drivetrain: car.drivetrain,
      drivetrainUnknownFlagged: false,
      accidentCount: car.accidentCount,
      accidentUnknownFlagged: false,
      seats: null,
      seatsUnknownFlagged: false,
      fuel: car.fuel,
      dealer: car.dealer,
      vdp: car.vdp,
      reconUsd: null,
      estimatedDaysToSell: null,
      daysFlagged: false,
    })),
  );
}

function fuelOf(plan: FindPlan | null): string | null {
  if (!plan) return null;
  if (plan.fuel.value === "hybrid" && plan.fuel.strength !== "none") return "hybrid";
  return plan.fuel.value;
}

function placeOf(specCase: GoldenCase): { zip: string | null; radiusMi: number | null } {
  if (specCase.location === "nationwide" || specCase.location === "from-note") return { zip: null, radiusMi: null };
  return { zip: specCase.location.zip, radiusMi: specCase.location.radiusMi };
}

function applyLocation(session: ClientSession, specCase: GoldenCase) {
  if (specCase.location === "from-note") return;
  if (specCase.location === "nationwide") {
    session.confirm({ zip: null, distanceMiles: null });
    return;
  }
  session.confirm({ zip: specCase.location.zip, distanceMiles: specCase.location.radiusMi });
}

function finalOf(run: Omit<GoldenRun, "final" | "elapsedMs">): GoldenRun["final"] {
  return {
    pickVin: run.pickVin,
    verdict: run.verdict,
    confidence: run.confidence,
    budgetUsd: run.specs.at(-1)?.hard.priceMaxUsd?.value ?? null,
    providerQueriesUsed: run.providerQueriesUsed,
    listingVins: run.listings.map((car) => car.vin),
  };
}

function queriesFrom(result: FindMatchResult, urlCount: number): number {
  const raw = result.body.providerQueriesUsed;
  const fromBody = typeof raw === "number" ? raw : 0;
  return Math.max(fromBody, urlCount);
}

async function runPersonal(
  specCase: GoldenCase,
  fetchImpl: typeof fetch,
  transportPending: boolean,
  unseen: boolean,
  attempts: TransportAttempt[],
): Promise<Omit<GoldenRun, "final" | "elapsedMs">> {
  const session = new ClientSession("personal");
  const specs: ObservedSpec[] = [];
  const steps: StepTiming[] = [];
  const proofs: Array<GoldenRun["proofRecords"][number]> = [];
  let fuelPreference: string | null = null;
  const planTimeout = profile("find_plan").timeoutMs;
  const notes = specCase.turns.filter(isNote);

  let matched: FindMatchResult | null = null;
  let lastUrls: string[] = [];
  for (const turn of specCase.turns) {
    if (!isNote(turn)) {
      session.confirm(turn.confirm);
      continue;
    }
    const started = Date.now();
    const { sentBudget } = await session.submit(turn.note, fetchImpl);
    steps.push({
      name: "find_plan",
      elapsedMs: Date.now() - started,
      profileTimeoutMs: planTimeout,
      status: "ok",
    });
    fuelPreference = fuelOf(session.plan);
    const last = turn === notes[notes.length - 1];
    if (specCase.search === "each" || last) {
      applyLocation(session, specCase);
      specs.push(session.spec(turn.note, sentBudget, specCase.location));
    }
    const shouldSearch = specCase.search === "each" || last;
    if (!shouldSearch) continue;
    const matchStarted = Date.now();
    const cursor = attempts.length;
    matched = await session.match(fetchImpl);
    lastUrls = listingSearchUrls(attempts.slice(cursor));
    steps.push({
      name: "inventory",
      elapsedMs: Date.now() - matchStarted,
      profileTimeoutMs: null,
      status: matched.ok ? "ok" : "failed",
    });
  }
  if (!matched) throw new Error(`${specCase.id} did not search.`);
  const listings = shownFromMatch(matched);
  const queries = queriesFrom(matched, lastUrls.length);
  let verdict: string | null = null;
  let confidence: GoldenRun["confidence"] = null;
  let headline: string | null = matched.ok ? matched.body.headline : null;
  let message: string | null = matched.ok ? matched.body.message : (!matched.ok ? String(matched.body.message ?? "") : null);
  let nextStep: string | null = matched.ok ? matched.body.nextStep : null;
  const decideStarted = Date.now();
  if (matched.ok && session.need) {
    const best = selectBestDealOnEvidence({
      need: session.need,
      listings: listings.map((car) => ({
        make: car.make,
        model: car.model,
        year: car.year,
        priceUsd: car.priceUsd,
        miles: car.miles,
        vin: car.vin,
        drivetrain: car.drivetrain,
        fuel: car.fuel,
        accidentCount: car.accidentCount,
      })),
      marketPool: [],
    });
    const decided = await runFindDecideServ({
      need: session.need,
      bestDeal: best,
      shortlistKeys: best.ranked.map((row) => row.key),
      receipts: [],
      marketPool: [],
      servKey: DUMMY_KEY,
      model: BASE_MODEL,
      fetchImpl,
    });
    proofs.push(...decided.proofRecords);
    verdict = decided.agentVerdict.verdict;
    confidence = confidenceOf(decided.decide.confidence);
    if (!message) message = decided.bestDeal.why;
  }
  steps.push({
    name: "find_decide",
    elapsedMs: Date.now() - decideStarted,
    profileTimeoutMs: profile("find_decide").timeoutMs,
    status: verdict ? "ok" : "skipped",
  });
  const charged = findDeliveryChargesCredit({
    ok: matched.ok,
    providerQueriesUsed: queries,
    listingCount: listings.length,
    emptyReason: matched.ok ? matched.body.emptyReason : null,
  });
  const stopped = !matched.ok && /no credit/i.test(message ?? "");
  const towingBlob = `${headline ?? ""} ${message ?? ""}`;
  return {
    caseId: specCase.id,
    specs,
    listings,
    providerQueriesUsed: queries,
    listingUrls: lastUrls,
    verdict,
    confidence,
    status: stopped ? "stopped" : matched.ok ? "ok" : "error",
    charged,
    pickVin: listings[0]?.vin ?? null,
    proofRecords: proofs,
    buyer: { headline, message, nextStep, journal: [] },
    steps,
    idempotencyKeys: session.keys,
    replayedPriorDelivery: session.replayed,
    appliedTargetProfitUsd: null,
    towing: /\b(can tow|towing capacity|tow rating)\b/i.test(towingBlob) && !/unknown/i.test(towingBlob) ? "claimed" : "unknown",
    recordingsPending: transportPending,
    unseenRequest: unseen,
    fuelPreference,
  };
}

async function runFlip(
  specCase: GoldenCase,
  fetchImpl: typeof fetch,
  transportPending: boolean,
  unseen: boolean,
  attempts: TransportAttempt[],
): Promise<Omit<GoldenRun, "final" | "elapsedMs">> {
  const note = specCase.turns.find(isNote)?.note ?? "";
  const budget = specCase.expect.budgetUsd ?? 0;
  const started = Date.now();
  const cursor = attempts.length;
  const result: ResaleSearchResult = await runResaleSearch(
    {
      budgetUsd: budget,
      zip: placeOf(specCase).zip,
      distanceMiles: placeOf(specCase).radiusMi,
      freeText: note,
      targetProfitUsd: null,
      timeToSell: "any",
      repairAbility: "unknown",
    },
    { ...depsFor(fetchImpl), servKey: DUMMY_KEY, servModel: BASE_MODEL, fetchImpl },
  );
  const elapsed = Date.now() - started;
  const body = result.body;
  const okBody = result.ok && "verdictAction" in body ? body : null;
  const inventoryBody = result.ok && "candidates" in body ? body : null;
  const candidates = okBody ? [okBody.best, ...okBody.alternatives].filter((row) => row != null) : inventoryBody?.candidates ?? [];
  const listings: ShownListing[] = candidates.flatMap((row) => {
    if (!row) return [];
    const days = row.estimatedDaysToSell;
    const flagged = row.risks.some((risk) => /30|sell within|days/i.test(risk));
    return [
      {
        vin: row.vin,
        year: row.listing.year,
        make: row.listing.make,
        model: row.listing.model,
        priceUsd: row.listing.priceUsd,
        miles: row.listing.miles,
        distanceMiles: row.listing.distanceMiles ?? null,
        drivetrain: row.listing.drivetrain,
        drivetrainUnknownFlagged: false,
        accidentCount: row.listing.accidentCount,
        accidentUnknownFlagged: false,
        seats: null,
        seatsUnknownFlagged: false,
        fuel: row.listing.fuel,
        dealer: row.listing.dealer,
        vdp: row.listing.vdp,
        reconUsd: row.reconUsd,
        estimatedDaysToSell: days,
        daysFlagged: flagged || (days != null && days > 30 && /flag|over|longer|goal/i.test(row.daysToSellBasis)),
      },
    ];
  });
  const fromBody = "providerQueriesUsed" in body && typeof body.providerQueriesUsed === "number" ? body.providerQueriesUsed : 0;
  const searchUrls = listingSearchUrls(attempts.slice(cursor));
  const queries = Math.max(fromBody, searchUrls.length);
  const message = ("message" in body ? body.message : null) ?? null;
  const headline = ("headline" in body ? body.headline : null) ?? null;
  const nextStep = ("nextStep" in body ? body.nextStep : null) ?? null;
  const journal = "journal" in body ? body.journal.steps.flatMap((step) => [step.decided, step.why].filter((line): line is string => Boolean(line))) : [];
  const proofs = okBody?.proofRecords ?? ("proofRecords" in body ? body.proofRecords ?? [] : []);
  const text = `${headline ?? ""} ${message ?? ""} ${journal.join(" ")}`;
  const hard: ObservedSpec["hard"] = {
    priceMaxUsd: { value: budget, source: "form" },
    radiusMi: { value: placeOf(specCase).radiusMi, source: "form" },
    zip: { value: placeOf(specCase).zip, source: "form" },
  };
  const enforced = {
    yearMin: null,
    yearMax: null,
    milesMax: null,
    priceMaxUsd: budget,
    zip: hard.zip?.value ?? null,
    radiusMi: hard.radiusMi?.value ?? null,
  };
  const draft = { v: 1 as const, mode: "flip" as const, note, hard, enforced };
  const charged = okBody?.chargedCredit === true;
  const verdict = okBody?.verdictAction ?? null;
  const noCredit = /no credit/i.test(message ?? "");
  return {
    caseId: specCase.id,
    specs: [{ ...draft, hash: sha256Canonical(draft) }],
    listings,
    providerQueriesUsed: queries,
    listingUrls: searchUrls,
    verdict,
    confidence: okBody ? confidenceOf(okBody.confidence) : null,
    status: !result.ok && noCredit ? "stopped" : result.ok ? "ok" : "error",
    charged: result.ok ? charged : false,
    pickVin: okBody?.best?.vin ?? listings[0]?.vin ?? null,
    proofRecords: proofs,
    buyer: { headline, message, nextStep, journal },
    steps: [
      {
        name: "resale",
        elapsedMs: elapsed,
        profileTimeoutMs: profile("resale_plan_search").timeoutMs,
        status: result.ok ? "ok" : "failed",
      },
    ],
    idempotencyKeys: [],
    replayedPriorDelivery: false,
    appliedTargetProfitUsd: /\$1,500/.test(text) && /target|margin/i.test(text) ? 1500 : null,
    towing: "unknown",
    recordingsPending: transportPending,
    unseenRequest: unseen,
    fuelPreference: null,
  };
}

export async function runGoldenCase(specCase: GoldenCase, mode: GoldenMode, spend?: Spend, root?: string): Promise<GoldenRun> {
  const started = Date.now();
  const transport = await createGoldenFetch({
    mode: mode === "live" ? "live" : mode,
    caseId: specCase.id,
    root: root ?? recordingsRoot(),
    secrets: [DUMMY_KEY],
    spend,
    liveFetch: mode === "replay" ? undefined : fetch,
  });
  const unseen = () => transport.attempts.some((row) => row.unseen);
  const body =
    specCase.kind === "flip"
      ? await runFlip(specCase, transport.fetch, transport.pending, false, transport.attempts)
      : await runPersonal(specCase, transport.fetch, transport.pending, false, transport.attempts);
  const done = { ...body, unseenRequest: unseen() };
  const elapsedMs = Date.now() - started;
  return { ...done, elapsedMs, final: finalOf(done) };
}
