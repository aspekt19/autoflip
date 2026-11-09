/**
 * Three comparison arms on the SAME captured inputs.
 * Fixture mode never calls the network. Live mode requires COMPARISON_ALLOW_PAID=1.
 */
import { listingRedFlags } from "@/domain/listing/red-flags";
import type { ExtractedListingFields } from "@/domain/listing/types";
import { selectBestDealOnEvidence } from "@/domain/find-best-deal";
import { explicitNeedFromText } from "@/domain/need";
import { evaluateListingPrice } from "@/domain/price-evaluation";
import type { Listing } from "@/domain/types";
import { BASE_MODEL } from "@/server/serv";
import { bandFromAskVsFair } from "./score";
import type {
  ArmOutput,
  CapturedListing,
  CheckCaseFixture,
  ComparisonArmId,
  FindCaseFixture,
  PlainLlmOutput,
  PriceBand,
} from "./types";

function toListing(row: CapturedListing): Listing {
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

export function runCheapestFind(fixture: FindCaseFixture): ArmOutput {
  const started = Date.now();
  const ranked = [...fixture.listings].sort((a, b) => a.priceUsd - b.priceUsd);
  const pick = ranked[0] ?? null;
  const fair = pick?.vin ? fixture.labels.fairValueByVin[pick.vin] ?? null : null;
  const summary = pick
    ? `Cheapest ask: ${pick.year} ${pick.make} ${pick.model} at $${pick.priceUsd}.`
    : "No listings.";
  return {
    arm: "cheapest",
    pickVin: pick?.vin ?? null,
    priceVerdict: bandFromAskVsFair(pick?.priceUsd ?? null, fair),
    fairValueUsd: fair,
    redFlags: pick ? [...soldFlag(pick, pick.description ?? ""), ...missingVinFlag(pick, pick.description ?? "")] : [],
    unknowns: ["Cheapest sort does not inspect title, recalls, or comps beyond the label fair value."],
    summary,
    latencyMs: Date.now() - started,
    costUsd: 0,
    textForNumbers: summary,
  };
}

export function runCheapestCheck(fixture: CheckCaseFixture): ArmOutput {
  const started = Date.now();
  const ask = fixture.subject.priceUsd;
  const fair = fixture.labels.fairValueUsd;
  const summary = `Cheapest-price arm on a single listing: ask $${ask}.`;
  return {
    arm: "cheapest",
    pickVin: fixture.subject.vin,
    priceVerdict: bandFromAskVsFair(ask, fair),
    fairValueUsd: fair,
    redFlags: [],
    unknowns: ["Single-listing cheapest arm does not scan red-flag language."],
    summary,
    latencyMs: Date.now() - started,
    costUsd: 0,
    textForNumbers: summary,
  };
}

export function runLemonlessFind(fixture: FindCaseFixture): ArmOutput {
  const started = Date.now();
  const parsed = explicitNeedFromText(fixture.query, "personal");
  const need = {
    ...parsed,
    budgetKnown: fixture.budgetUsd != null,
    budgetUsd: fixture.budgetUsd,
    zip: fixture.zip,
    note: fixture.query,
  };
  // Production Check would refuse SOLD; filter sold captures before ranking so Find
  // does not "pick" an unavailable car just because it is cheapest in the fixture.
  const usableCaptured = fixture.listings.filter((row) => row.availability !== "sold");
  const listings = usableCaptured.map(toListing);
  const result = selectBestDealOnEvidence({
    need,
    listings,
    marketPool: [...fixture.listings, ...fixture.comps].map(toListing),
    nowYear: 2026,
  });
  const pickKey = result.pick?.vin ?? result.pick?.key ?? null;
  const pickListing = listings.find((row) => row.vin === pickKey) ?? null;
  const captured = fixture.listings.find((row) => row.vin === pickKey) ?? null;
  const fair = pickKey ? fixture.labels.fairValueByVin[pickKey] ?? null : null;
  const evalPrice =
    pickListing != null
      ? evaluateListingPrice(pickListing, [...listings, ...fixture.comps.map(toListing)])
      : null;
  const fairValueUsd = evalPrice?.fairValueUsd ?? fair;
  const flags = new Set<string>();
  for (const row of fixture.listings) {
    for (const id of soldFlag(row, row.description ?? "")) flags.add(`${row.vin}:sold`);
    if (row.availability === "sold") flags.add("sold");
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
  const unknowns: string[] = [];
  if (!result.pick) unknowns.push("No usable pick after evidence ranking.");
  if (result.confidence === "low" || result.confidence === "none") unknowns.push(`Confidence: ${result.confidence}`);
  unknowns.push(...result.stillUnknown.slice(0, 3));
  const pickLabel = result.pick
    ? `${result.pick.year} ${result.pick.make} ${result.pick.model}`
    : null;
  const summary = result.pick
    ? `Lemonless pick ${pickLabel} (${result.confidence}). ${result.settlementNote}`
    : `Lemonless withheld a pick. ${result.settlementNote}`;
  // Space-separate figures so comma-grouping does not glue JSON array digits into one token.
  // Avoid model codes with digits (CX-5, RAV4, CR-V) in invent-check text.
  const textForNumbers = [
    `pick ${pickKey ?? "none"}`,
    `year ${result.pick?.year ?? ""}`,
    `prices ${fixture.listings.map((r) => r.priceUsd).join(" ")}`,
    `miles ${fixture.listings.map((r) => r.miles).join(" ")}`,
    `years ${fixture.listings.map((r) => r.year).join(" ")}`,
    `budget ${fixture.budgetUsd ?? "none"}`,
    `zip ${fixture.zip}`,
    fixture.query.replace(/\b(CX|CR|RAV|F|CT)-?\d+\b/gi, "MODEL"),
  ].join(" | ");
  return {
    arm: "lemonless",
    pickVin: pickKey,
    priceVerdict: bandFromAskVsFair(pickListing?.priceUsd ?? null, fairValueUsd),
    fairValueUsd,
    redFlags: [...flags],
    unknowns,
    summary,
    latencyMs: Date.now() - started,
    costUsd: 0,
    textForNumbers,
  };
}

export function runLemonlessCheck(fixture: CheckCaseFixture): ArmOutput {
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
  const unknowns = [...fixture.subject.vin ? [] : ["VIN missing from listing"], ...price.fairValueUsd == null ? ["Fair value not established"] : []];
  const walk =
    flags.includes("sold") || flags.includes("title_brand")
      ? "Walk away until title/availability is cleared."
      : flags.includes("missing_vin")
        ? "Do not buy without a VIN decode and history."
        : price.priced
          ? `Price reading: ${price.label}.`
          : "Price reading incomplete.";
  const summary = `${fixture.subject.year} ${fixture.subject.make} ${fixture.subject.model} ask $${fixture.subject.priceUsd}. ${walk}`;
  const textForNumbers = [
    `ask ${fixture.subject.priceUsd}`,
    `year ${fixture.subject.year}`,
    `miles ${fixture.subject.miles}`,
    `compPrices ${fixture.comps.map((c) => c.priceUsd).join(" ")}`,
    `compMiles ${fixture.comps.map((c) => c.miles).join(" ")}`,
    fixture.rawText,
  ].join(" | ");
  return {
    arm: "lemonless",
    pickVin: flags.includes("sold") ? null : fixture.subject.vin,
    priceVerdict: flags.includes("sold")
      ? "unknown"
      : bandFromAskVsFair(fixture.subject.priceUsd, price.fairValueUsd ?? fixture.labels.fairValueUsd),
    fairValueUsd: price.fairValueUsd ?? fixture.labels.fairValueUsd,
    redFlags: flags,
    unknowns,
    summary,
    latencyMs: Date.now() - started,
    costUsd: 0,
    textForNumbers,
  };
}

export function runPlainOfflineFind(fixture: FindCaseFixture): ArmOutput {
  return plainFromCanned("plain_llm", fixture.plainLlmOffline, Date.now());
}

export function runPlainOfflineCheck(fixture: CheckCaseFixture): ArmOutput {
  return plainFromCanned("plain_llm", fixture.plainLlmOffline, Date.now());
}

function plainFromCanned(arm: ComparisonArmId, canned: PlainLlmOutput, started: number): ArmOutput {
  const text = `${canned.summary} fairValueUsd=${canned.fairValueUsd ?? ""} verdict=${canned.priceVerdict} flags=${canned.redFlags.join(",")}`;
  return {
    arm,
    pickVin: canned.pickVin,
    priceVerdict: canned.priceVerdict,
    fairValueUsd: canned.fairValueUsd,
    redFlags: canned.redFlags,
    unknowns: canned.unknowns,
    summary: canned.summary,
    latencyMs: Math.max(1, Date.now() - started),
    costUsd: 0,
    textForNumbers: text,
  };
}

export function liveAllowed(): boolean {
  if (process.env.COMPARISON_DRY_RUN === "1") return false;
  return process.env.COMPARISON_ALLOW_PAID === "1" && Boolean(process.env.SERV_API_KEY?.trim());
}

/**
 * Live plain LLM: one chat completion on the same captured payload.
 * Estimated ~$0.01–0.03 per call on gpt-5.4-mini (costUsd left null unless usage returns).
 */
export async function runPlainLiveFind(fixture: FindCaseFixture): Promise<ArmOutput> {
  const started = Date.now();
  const user = [
    "You are a used-car shopping assistant. Given this buyer query and captured listings JSON, pick ONE vin, state a price verdict band",
    "(far_below|below|fair|above|far_above|unknown), optional fairValueUsd, red flag ids, unknowns, and a one-sentence summary.",
    "Reply JSON only: {pickVin,priceVerdict,fairValueUsd,redFlags,unknowns,summary}",
    `Query: ${fixture.query}`,
    `ZIP: ${fixture.zip}`,
    `Budget: ${fixture.budgetUsd}`,
    `Listings: ${JSON.stringify(fixture.listings)}`,
  ].join("\n");
  const parsed = await callPlainLlm(user);
  return plainFromCanned("plain_llm", parsed, started);
}

export async function runPlainLiveCheck(fixture: CheckCaseFixture): Promise<ArmOutput> {
  const started = Date.now();
  const user = [
    "You are a used-car listing checker. Given raw listing text + subject + comps, decide if it is buyable.",
    "Reply JSON only: {pickVin,priceVerdict,fairValueUsd,redFlags,unknowns,summary}",
    "priceVerdict one of far_below|below|fair|above|far_above|unknown. Include sold/salvage/missing_vin in redFlags when present.",
    `Raw text:\n${fixture.rawText}`,
    `Subject: ${JSON.stringify(fixture.subject)}`,
    `Comps: ${JSON.stringify(fixture.comps)}`,
  ].join("\n");
  const parsed = await callPlainLlm(user);
  return plainFromCanned("plain_llm", parsed, started);
}

/**
 * Live Lemonless SERV pass: one verdict_decide-style call on already-computed facts.
 * Domain ranking/pricing still run locally first (as production: code owns numbers).
 */
export async function runLemonlessLiveFind(fixture: FindCaseFixture): Promise<ArmOutput> {
  const base = runLemonlessFind(fixture);
  if (!liveAllowed()) return base;
  const started = Date.now();
  const { runServ } = await import("@/server/serv");
  const facts = {
    pickVin: base.pickVin,
    priceVerdict: base.priceVerdict,
    fairValueUsd: base.fairValueUsd,
    redFlags: base.redFlags,
    listings: fixture.listings.map((row) => ({
      vin: row.vin,
      priceUsd: row.priceUsd,
      miles: row.miles,
      availability: row.availability,
    })),
  };
  const result = await runServ(
    "verdict_decide",
    {
      user: `Buyer query: ${fixture.query}\nCalculated facts:\n${JSON.stringify(facts)}\nChoose buy|negotiate|pass|needs_inspection. Do not invent dollar amounts.`,
      facts,
    },
    {
      apiKey: process.env.SERV_API_KEY,
      model: process.env.SERV_MODEL || BASE_MODEL,
      fetch,
      transportPolicy: "experiment_single_attempt",
    },
  );
  const extra = result.ok ? result.text : "SERV unavailable";
  return {
    ...base,
    summary: `${base.summary} SERV: ${extra.slice(0, 240)}`,
    latencyMs: Date.now() - started + base.latencyMs,
    costUsd: null,
    textForNumbers: base.textForNumbers,
    unknowns: result.ok ? base.unknowns : [...base.unknowns, "SERV call failed"],
  };
}

export async function runLemonlessLiveCheck(fixture: CheckCaseFixture): Promise<ArmOutput> {
  const base = runLemonlessCheck(fixture);
  if (!liveAllowed()) return base;
  const started = Date.now();
  const { runServ } = await import("@/server/serv");
  const facts = {
    askUsd: fixture.subject.priceUsd,
    fairValueUsd: base.fairValueUsd,
    redFlags: base.redFlags,
    availability: fixture.subject.availability,
    vin: fixture.subject.vin,
  };
  const result = await runServ(
    "verdict_decide",
    {
      user: `Listing check. Calculated facts:\n${JSON.stringify(facts)}\nRaw excerpt:\n${fixture.rawText.slice(0, 1200)}\nChoose buy|negotiate|pass|needs_inspection. Do not invent dollar amounts.`,
      facts,
    },
    {
      apiKey: process.env.SERV_API_KEY,
      model: process.env.SERV_MODEL || BASE_MODEL,
      fetch,
      transportPolicy: "experiment_single_attempt",
    },
  );
  const extra = result.ok ? result.text : "SERV unavailable";
  return {
    ...base,
    summary: `${base.summary} SERV: ${extra.slice(0, 240)}`,
    latencyMs: Date.now() - started + base.latencyMs,
    costUsd: null,
    textForNumbers: base.textForNumbers,
    unknowns: result.ok ? base.unknowns : [...base.unknowns, "SERV call failed"],
  };
}

async function callPlainLlm(user: string): Promise<PlainLlmOutput> {
  const key = process.env.SERV_API_KEY?.trim();
  if (!key) throw new Error("SERV_API_KEY required for live plain LLM");
  const base = (process.env.SERV_BASE_URL || "https://inference-api.openserv.ai/v1").replace(/\/$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.SERV_MODEL || BASE_MODEL,
      stream: false,
      messages: [
        { role: "system", content: "Return only compact JSON. Never invent VINs or dollar figures that are not in the user payload." },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const text = payload?.choices?.[0]?.message?.content?.trim() ?? "";
  return parsePlainJson(text);
}

function parsePlainJson(text: string): PlainLlmOutput {
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
    const parsed = JSON.parse(match[0]) as Partial<PlainLlmOutput>;
    const band = parsed.priceVerdict;
    const okBand: PriceBand[] = ["far_below", "below", "fair", "above", "far_above", "unknown"];
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
