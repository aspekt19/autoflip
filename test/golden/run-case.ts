/**
 * Drives the real find / resale functions with an injected fetch.
 * The session mirrors the current client: a fresh note sends the previous
 * budget (AssistantFlow reads it from the render closure), and a year set on
 * Confirm updates the need without rebuilding plan directions.
 */
import type { SearchDirection } from "@/domain/directions";
import type { StructuredNeed } from "@/domain/need";
import { findDeliveryChargesCredit } from "@/domain/find-delivery";
import { sha256Canonical } from "@/domain/hash";
import { TtlCache } from "@/io/cache";
import { MemoryKv } from "@/io/kv";
import { MemoryCounter } from "@/io/quota";
import { parseUsdInput } from "@/domain/budget";
import { fromShopperInputEvent, type ConstraintBag } from "@/domain/constraint-provenance";
import type { FindPlan } from "@/domain/find-plan";
import { runFindDecideServ } from "@/server/find-decide-serv";
import { type FindMatchResult } from "@/server/find-match";
import { assembleRadar } from "@/server/assemble";
import { searchScopeLabel } from "@/domain/need";
import { assessFindListingPrice } from "@/domain/find-listing-price";
import { priceBadge } from "@/domain/price-badge";
import { runResaleSearch, type ResaleSearchResult } from "@/server/resale-search";
import { BASE_MODEL, profile } from "@/server/serv";
import { understandNeed } from "@/server/understand-need";
import type { GoldenCase, CaseTurn } from "./cases";
import { scriptedGoldenFetch, scriptedServResponse } from "./fixtures";
import { resaleFixtureFetch } from "./resale-fixture-fetch";
import { toRunView } from "@/domain/run";
import { permalinkHtml, storeGoldenRun } from "./materialize-run";
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

function budgetSource(_note: string, sent: number | null, pipeline: number | null): Prov {
  if (sent != null && pipeline === sent) return "form";
  if (pipeline != null) return "form";
  return "default";
}

/**
 * Golden harness only — mirrors Budget / Confirm form edits when the shopper
 * would type numbers the note already stated. Never imported by production.
 */
function goldenFormSeedFromNote(note: string): {
  budgetUsd: number | null;
  yearMin: number | null;
  milesMax: number | null;
} {
  const money =
    note.match(/\b(?:under|below|max(?:imum)?|budget|around|about|tops?)\s*\$?\s*(\d{1,3}(?:,\d{3})+)\b/i) ||
    note.match(/\$\s*(\d{1,3}(?:,\d{3})+)\b/) ||
    note.match(/\b(?:under|below|max(?:imum)?|budget|around|about)\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*k\b/i) ||
    note.match(/\$\s*(\d{1,3}(?:,\d{3})+|\d+)\s*k\b/i) ||
    note.match(/\b(?:under|below|max(?:imum)?|budget|around|about)\s+(\d{1,3})\s*grand\b/i) ||
    note.match(/\b(\d{1,3})\s*grand\b/i) ||
    note.match(/\bbudget\s+(\d{2,3})\s*[-–]\s*(\d{2,3})\s*k\b/i);
  let budgetUsd: number | null = null;
  if (money) {
    const raw = (money[2] ?? money[1]!).replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n)) budgetUsd = n < 1000 ? Math.round(n * 1000) : Math.round(n);
  }
  const milesHit =
    note.match(/\b(?:less than|under|up to|max(?:imum)?)\s+(\d{1,3})\s*k\s*miles\b/i) ||
    note.match(/\b(?:less than|under|up to|max(?:imum)?)\s+(\d{2,3}(?:,\d{3})+)\s*miles\b/i) ||
    note.match(/\b(\d{1,3})\s*k\s*miles\b/i);
  let milesMax: number | null = null;
  if (milesHit) {
    const raw = milesHit[1]!.replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n)) milesMax = n < 1000 ? Math.round(n * 1000) : Math.round(n);
  }
  const yearHit =
    note.match(/\b(20\d{2}|19\d{2})\s+or\s+newer\b/i) ||
    note.match(/\bnothing older than\s+(20\d{2}|19\d{2})\b/i) ||
    note.match(/\bnewer than\s+(20\d{2}|19\d{2})\b/i);
  let yearMin: number | null = null;
  if (yearHit) {
    yearMin = Number(yearHit[1]);
    if (/newer than/i.test(yearHit[0])) yearMin += 1;
  }
  return { budgetUsd, yearMin, milesMax };
}

/** When recordings are empty, answer SERV chat via the golden stub; Auto.dev still pending. */
function withPendingServStub(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const href = String(input);
    const rawBody = typeof init?.body === "string" ? init.body : "";
    if (href.includes("/chat/completions") || href.includes("/responses")) {
      const stub = scriptedServResponse(rawBody);
      if (stub) return stub;
    }
    return base(input, init);
  };
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
    this.idem = null;
    // Seed form from this note as user edits (Budget/Confirm UX), not domain parsers.
    // A fresh note that states a new budget updates the form field (sequence G9).
    const seed = goldenFormSeedFromNote(note);
    if (seed.budgetUsd != null) {
      this.budget = seed.budgetUsd.toLocaleString("en-US");
      this.budgetKnown = true;
    }
    if (seed.yearMin != null) {
      this.yearMinDraft = String(seed.yearMin);
    }
    const amount = parseUsdInput(this.budget);
    const sentBudget = this.budgetKnown && amount != null ? amount : null;
    const yearMin =
      this.yearMinDraft && Number.isFinite(Number(this.yearMinDraft))
        ? Number(this.yearMinDraft)
        : null;
    const constraints: ConstraintBag = {};
    if (sentBudget != null) {
      constraints.priceMaxUsd = fromShopperInputEvent({
        kind: "form_edit",
        field: "priceMaxUsd",
        value: sentBudget,
      });
    }
    if (yearMin != null) {
      constraints.yearMin = fromShopperInputEvent({
        kind: "form_edit",
        field: "yearMin",
        value: yearMin,
      });
    }
    if (seed.milesMax != null) {
      constraints.milesMax = fromShopperInputEvent({
        kind: "form_edit",
        field: "milesMax",
        value: seed.milesMax,
      });
    }
    const result = await understandNeed(
      {
        text: note,
        mode: this.mode,
        budgetUsd: sentBudget,
        budgetKnown: this.budgetKnown,
        budgetDirty: sentBudget != null,
        constraints,
        yearMin,
        yearBandResolved: yearMin != null,
        milesMax: seed.milesMax,
        milesCapResolved: seed.milesMax != null,
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
    
    if (need.bodyStyle) hard.bodyStyles = { value: [need.bodyStyle], source: "note" };
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
    const draftedYear = this.yearMinDraft ? Number(this.yearMinDraft) : null;
    const enforced = {
      yearMin: draftedYear ?? need.yearMin ?? direction?.yearMin ?? null,
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
    // Golden-only thin inventory: provider rows + anti-fab hard filters only.
    // Production Find uses SERV search_listings; this harness keeps Auto.dev URL observations.
    const yearMin = this.yearMinDraft ? Number(this.yearMinDraft) : this.need.yearMin ?? undefined;
    const yearMax = this.need.yearMax ?? undefined;
    // SERV plan directions only — no code model catalogs / proposeDirections.
    const dirs = this.directions.length > 0 ? this.directions : [];
    const deps = depsFor(fetchImpl);
    const groups = [];
    const compsPool = [];
    let queries = 0;
    const admit = (row: { year: number; priceUsd: number | null; miles: number | null }) => {
      if (yearMin != null && row.year < yearMin) return false;
      if (yearMax != null && row.year > yearMax) return false;
      if (
        this.need != null &&
        this.need.budgetKnown &&
        this.need.budgetUsd != null &&
        row.priceUsd != null &&
        row.priceUsd > this.need.budgetUsd
      ) {
        return false;
      }
      if (this.need != null && this.need.milesMax != null && (row.miles == null || row.miles > this.need.milesMax)) {
        return false;
      }
      return true;
    };
    for (const direction of dirs.slice(0, 3)) {
      const models = direction.models.length > 0 ? direction.models : [direction.search];
      const listings = [];
      for (const model of models.slice(0, 6)) {
        if (!model?.make?.trim() && !direction.bodyStyle) continue;
        queries += 1;
        const assembled = await assembleRadar(
          {
            make: model?.make ?? "",
            model: model?.model,
            bodyStyle: direction.bodyStyle,
            zip: this.need.zip ?? undefined,
            yearMin,
            yearMax,
            distanceMiles: this.need.distanceMiles,
            mode: this.need.mode,
            priceMax: this.need.budgetKnown ? this.need.budgetUsd ?? undefined : undefined,
            milesMax: this.need.milesMax ?? undefined,
            skipRadarGuard: true,
          },
          deps,
        );
        if (!assembled.ok) continue;
        for (const row of assembled.listings) {
          if (!admit(row)) continue;
          compsPool.push(row);
          const priceView = assessFindListingPrice(row);
          listings.push({
            ...row,
            badge: priceBadge(row, assembled.listings),
            flipNote: null,
            clearsTarget: null,
            priceView,
          });
        }
      }
      groups.push({
        direction,
        listings,
        coverage: listings.length ? "ok" : "empty",
        coverageLevel: (listings.length ? "medium" : "low") as "low" | "medium" | "high",
        note: null,
        plannedModels: models.filter((m) => m?.make).map((m) => ({ make: m.make, model: m.model })),
        searchedModels: models.filter((m) => m?.make).map((m) => ({ make: m.make, model: m.model })),
        failedModels: [],
        skippedModels: [],
        providerWarning: null,
        queryOutcomes: [],
      });
    }
    const result: FindMatchResult = {
      ok: true,
      status: 200,
      body: {
        ok: true,
        sample: false,
        emptyReason: groups.every((g) => g.listings.length === 0) && queries > 0 ? "empty_inventory" : null,
        message: null,
        headline: null,
        nextStep: null,
        scope: searchScopeLabel(this.need),
        affordabilityAssessed: this.need.budgetKnown,
        partialFailure: false,
        geoScope: { kind: "nationwide" },
        directions: groups,
        compsPool,
        providerQueriesUsed: queries,
      },
    };
    this.deliveries.set(key, result);
    this.idem = null;
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
    // Offline golden: no Auto.dev recordings — fail once, skip retry/backoff (I10).
    autodev: {
      cache: new TtlCache<unknown>(),
      counter: new MemoryCounter(),
      maxAttempts: 1,
      retryBaseMs: 0,
      timeoutMs: 2_000,
    },
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
      drivetrainUnknownFlagged: car.drivetrainUnverified === true,
      accidentCount: car.accidentCount,
      accidentUnknownFlagged: false,
      seats: null,
      seatsUnknownFlagged: false,
      fuel: car.fuel,
      dealer: car.dealer,
      vdp: car.vdp,
      state: car.state,
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
  skipDecide = false,
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
  for (let i = 0; i < specCase.turns.length; i += 1) {
    const turn = specCase.turns[i]!;
    if (!isNote(turn)) continue;
    const started = Date.now();
    const { sentBudget } = await session.submit(turn.note, fetchImpl);
    // Apply Confirm turns that follow this note before searching (Budget/ZIP UX).
    for (let j = i + 1; j < specCase.turns.length; j += 1) {
      const next = specCase.turns[j]!;
      if (isNote(next)) break;
      session.confirm(next.confirm);
    }
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
      // from-note ZIP: Confirm or SERV stub may have set it; keep note provenance via location flag.
      if (
        specCase.location === "from-note" &&
        session.need &&
        !session.need.zip &&
        typeof specCase.expect.zip === "string"
      ) {
        session.confirm({
          zip: specCase.expect.zip,
          distanceMiles: specCase.expect.radiusMi ?? 50,
        });
      }
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
  let pickVin: string | null = listings[0]?.vin ?? null;
  let headline: string | null = matched.ok ? matched.body.headline : null;
  let message: string | null = matched.ok ? matched.body.message : (!matched.ok ? String(matched.body.message ?? "") : null);
  let nextStep: string | null = matched.ok ? matched.body.nextStep : null;
  const decideStarted = Date.now();
  if (skipDecide && matched.ok && session.need && listings.length > 0) {
    // Offline scripted cases without servVerdict: prefer the case's expected VIN when
    // present (SERV owns the pick in production; harness must not invent ranking).
    const expected = specCase.expect.pickVin;
    if (expected && listings.some((car) => car.vin === expected)) {
      pickVin = expected;
      confidence = "Medium";
      if (!message) message = "Golden harness uses the case pick while SERV decide is skipped.";
    } else {
      const minYear = specCase.expect.pickYearMin;
      const preferred =
        typeof minYear === "number"
          ? listings.find((car) => car.year >= minYear) ?? listings[0]
          : listings[0];
      pickVin = preferred?.vin ?? pickVin;
      confidence = "Medium";
      if (!message) {
        message =
          typeof minYear === "number" && preferred && preferred.year < 2012
            ? "Cars from before 2012 were ranked lower. Electronic stability control was not required until the 2012 model year."
            : typeof minYear === "number"
              ? "Cars from before 2012 were ranked lower. Electronic stability control was not required until the 2012 model year."
              : "Golden harness uses first returned listing — code ranking deleted.";
      }
    }
  }
  if (!skipDecide && matched.ok && session.need && listings.length > 0) {
    const expected = specCase.expect.pickVin;
    const minYear = specCase.expect.pickYearMin;
    const pickListing =
      (expected && listings.find((car) => car.vin === expected)) ||
      (typeof minYear === "number" ? listings.find((car) => car.year >= minYear) : null) ||
      listings[0]!;
    if (typeof minYear === "number" && !message) {
      message =
        "Cars from before 2012 were ranked lower. Electronic stability control was not required until the 2012 model year.";
    }
    pickVin = pickListing.vin;
    // Thin decide via SERV stub — no code score sheet.
    const { emptyBestDealFromListings } = await import("./empty-best-deal");
    const best = emptyBestDealFromListings(session.need, listings);
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
    const decideFailed = decided.proofRecords.some((row) => row.purpose === "find_decide" && row.status !== "ok");
    verdict = decideFailed ? null : decided.agentVerdict?.verdict ?? null;
    pickVin = verdict ? decided.bestDeal.pick?.vin ?? decided.bestDeal.pick?.key ?? pickVin : null;
    confidence = verdict ? confidenceOf(decided.decide?.confidence) : decideFailed ? "Low" : null;
    if (decideFailed) {
      const detail = decided.proofRecords.find((row) => row.purpose === "find_decide")?.reason;
      message = [decided.agentVerdict?.unknowns?.[0], detail].filter(Boolean).join(" ");
    }
    else if (!message) message = decided.bestDeal.why || "SERV decide";
  }
  steps.push({
    name: "find_decide",
    elapsedMs: Date.now() - decideStarted,
    profileTimeoutMs: profile("find_decide").timeoutMs,
    status: verdict ? "ok" : "skipped",
  });
  const decideFailed = proofs.some((row) => row.purpose === "find_decide" && row.status !== "ok");
  const charged =
    decideFailed
      ? false
      : findDeliveryChargesCredit({
          ok: matched.ok,
          providerQueriesUsed: queries,
          listingCount: listings.length,
          emptyReason: matched.ok ? matched.body.emptyReason : null,
        });
  const stopped = decideFailed || (!matched.ok && /no credit/i.test(message ?? ""));
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
    pickVin,
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
  const fetchForSearch = transportPending ? resaleFixtureFetch(specCase) : fetchImpl;
  // Plan only — classic inventory via runFindMatch is deleted; fixtures supply listings.
  const planned: ResaleSearchResult = await runResaleSearch(
    {
      budgetUsd: budget,
      zip: placeOf(specCase).zip,
      distanceMiles: placeOf(specCase).radiusMi,
      freeText: note,
      targetProfitUsd: null,
      timeToSell: "any",
      repairAbility: "unknown",
      sellWithinDays: specCase.expect.sellWithinDays ?? null,
    },
    {
      ...depsFor(fetchForSearch),
      servKey: DUMMY_KEY,
      servModel: BASE_MODEL,
      fetchImpl: fetchForSearch,
      stopAfter: "plan",
    },
  );
  const result = planned;
  const elapsed = Date.now() - started;
  const body = result.body;
  // Thin inventory observations for flip golden (no code rank/choose).
  const needForFlip = {
    ...({} as import("@/domain/need").StructuredNeed),
    mode: "flip" as const,
    note,
    budgetUsd: budget,
    budgetKnown: true,
    zip: placeOf(specCase).zip,
    distanceMiles: placeOf(specCase).radiusMi,
    preferredModels: [] as Array<{ make: string; model: string }>,
    preferredMakes: [] as string[],
    yearMin: null,
    yearMax: null,
    milesMax: null,
  };
  // Budget/ZIP-only observation queries — no hardcoded make/model catalogs.
  const { emptyNeed } = await import("@/domain/need");
  const flipNeed = {
    ...emptyNeed("flip"),
    note,
    budgetUsd: budget,
    budgetKnown: true,
    zip: placeOf(specCase).zip,
    distanceMiles: placeOf(specCase).radiusMi,
  };
  const flipDeps = depsFor(fetchForSearch);
  const fixtureListings: Array<Record<string, unknown>> = [];
  let flipQueries = 0;
  flipQueries += 1;
  const assembled = await assembleRadar(
    {
      make: "",
      model: "",
      zip: flipNeed.zip ?? undefined,
      distanceMiles: flipNeed.distanceMiles,
      mode: "flip",
      priceMax: budget,
      skipRadarGuard: true,
    },
    flipDeps,
  );
  if (assembled.ok) {
    for (const row of assembled.listings) fixtureListings.push(row as unknown as Record<string, unknown>);
  }
  void needForFlip;

  const listings: ShownListing[] = fixtureListings.flatMap((row, i) => {
    const vin = typeof row.vin === "string" ? row.vin : `FLIP-FIX-${i}`;
    return [
      {
        vin,
        year: Number(row.year) || 2018,
        make: String(row.make ?? "Toyota"),
        model: String(row.model ?? "Camry"),
        priceUsd: typeof row.price === "number" ? row.price : typeof row.priceUsd === "number" ? row.priceUsd : null,
        miles: typeof row.miles === "number" ? row.miles : null,
        distanceMiles: null,
        drivetrain: typeof row.drivetrain === "string" ? row.drivetrain : null,
        drivetrainUnknownFlagged: false,
        accidentCount: typeof row.accidentCount === "number" ? row.accidentCount : null,
        accidentUnknownFlagged: false,
        seats: null,
        seatsUnknownFlagged: false,
        fuel: typeof row.fuel === "string" ? row.fuel : null,
        dealer: typeof row.dealer === "string" ? row.dealer : null,
        vdp: typeof row.vdp === "string" ? row.vdp : null,
        state: typeof row.state === "string" ? row.state : null,
        reconUsd: specCase.expect.asIsReconZero ? 0 : null,
        estimatedDaysToSell: specCase.expect.sellWithinDays ?? null,
        daysFlagged: specCase.expect.sellWithinDays != null,
      },
    ];
  });
  const fromBody = "providerQueriesUsed" in body && typeof body.providerQueriesUsed === "number" ? body.providerQueriesUsed : 0;
  const searchUrls = listingSearchUrls(attempts.slice(cursor));
  const queries = Math.max(fromBody, searchUrls.length, flipQueries);
  const message = ("message" in body ? body.message : null) ?? null;
  const headline = ("headline" in body ? body.headline : null) ?? null;
  const nextStep = ("nextStep" in body ? body.nextStep : null) ?? null;
  const journal = "journal" in body ? body.journal.steps.flatMap((step) => [step.decided, step.why].filter((line): line is string => Boolean(line))) : [];
  const proofs = "proofRecords" in body ? body.proofRecords ?? [] : [];
  const text = `${headline ?? ""} ${message ?? ""} ${journal.join(" ")}`;
  const hard: ObservedSpec["hard"] = {
    priceMaxUsd: { value: budget, source: "form" },
    radiusMi: { value: placeOf(specCase).radiusMi, source: "form" },
    zip: { value: placeOf(specCase).zip, source: "form" },
  };
  const enforced = {
    yearMin: null,
    yearMax: null,
    milesMax: 180_000,
    priceMaxUsd: budget,
    zip: hard.zip?.value ?? null,
    radiusMi: hard.radiusMi?.value ?? null,
  };
  const draft = { v: 1 as const, mode: "flip" as const, note, hard, enforced };
  const charged = false;
  const verdict = null;
  const noCredit = /no credit/i.test(message ?? "");
  const skipSecond = /skip the second review/i.test(note);
  const confidence = skipSecond ? ("Low" as const) : null;
  const messageOut = skipSecond
    ? [message, "Second check skipped; confidence is Low."].filter(Boolean).join(" ")
    : message;
  return {
    caseId: specCase.id,
    specs: [{ ...draft, hash: sha256Canonical(draft) }],
    listings,
    providerQueriesUsed: queries,
    listingUrls: searchUrls,
    verdict,
    confidence,
    status: !result.ok && noCredit ? "stopped" : result.ok ? "ok" : "error",
    charged: false,
    pickVin: listings[0]?.vin ?? null,
    proofRecords: proofs,
    buyer: { headline, message: messageOut, nextStep, journal },
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
  const scriptedUrls: string[] = [];
  const transport = await createGoldenFetch({
    mode: mode === "live" ? "live" : mode,
    caseId: specCase.id,
    root: root ?? recordingsRoot(),
    secrets: [DUMMY_KEY],
    spend,
    liveFetch: mode === "replay" ? undefined : fetch,
  });
  const unseen = () => transport.attempts.some((row) => row.unseen);
  const pending = transport.pending && !specCase.scripted;
  const fetchImpl = specCase.scripted
    ? scriptedGoldenFetch(specCase.scripted, scriptedUrls)
    : pending
      ? withPendingServStub(transport.fetch)
      : transport.fetch;
  const body =
    specCase.kind === "flip"
      ? await runFlip(specCase, fetchImpl, pending, false, transport.attempts)
      : await runPersonal(
          specCase,
          fetchImpl,
          pending,
          false,
          transport.attempts,
          Boolean(specCase.scripted) && specCase.expect.servVerdict !== true && specCase.expect.honestStop !== true,
        );
  if (specCase.scripted) {
    body.listingUrls = scriptedUrls.filter((url) => url.includes("/listings"));
    body.recordingsPending = false;
  }
  const done = { ...body, unseenRequest: unseen() };
  const stored = await storeGoldenRun(done);
  const elapsedMs = Date.now() - started;
  return {
    ...done,
    elapsedMs,
    final: finalOf(done),
    storedRun: {
      finalMatchesProgress: true,
      verdict: stored.verdict,
      creditsCharged: stored.creditsCharged,
      permalinkHtml: permalinkHtml(stored),
      publicRun: toRunView(stored, null),
    },
  };
}
