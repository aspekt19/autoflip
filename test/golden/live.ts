/**
 * Live mode: the same cases over HTTP against a prod or preview deployment.
 * No recordings are written. Requires a signed-in cookie.
 */
import type { GoldenCase } from "./cases";
import { dispositionFor, type GateDisposition } from "./known-failures";
import { assertInvariants } from "./invariants";
import { renderBuyerHtml } from "./render";
import { sha256Canonical } from "@/domain/hash";
import type { GoldenRun, ShownListing } from "./types";

type Json = Record<string, unknown>;

async function post(base: string, cookie: string, path: string, body: unknown): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Json;
  return { status: response.status, json };
}

function listingsFrom(json: Json): ShownListing[] {
  const groups = Array.isArray(json.directions) ? json.directions : [];
  const out: ShownListing[] = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const rows = (group as { listings?: unknown }).listings;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const car = row as Record<string, unknown>;
      if (typeof car.vin !== "string" || typeof car.year !== "number") continue;
      out.push({
        vin: car.vin,
        year: car.year,
        make: typeof car.make === "string" ? car.make : "",
        model: typeof car.model === "string" ? car.model : "",
        priceUsd: typeof car.priceUsd === "number" ? car.priceUsd : null,
        miles: typeof car.miles === "number" ? car.miles : null,
        distanceMiles: typeof car.distanceMiles === "number" ? car.distanceMiles : null,
        drivetrain: typeof car.drivetrain === "string" ? car.drivetrain : null,
        drivetrainUnknownFlagged: false,
        accidentCount: typeof car.accidentCount === "number" ? car.accidentCount : null,
        accidentUnknownFlagged: false,
        seats: null,
        seatsUnknownFlagged: false,
        fuel: typeof car.fuel === "string" ? car.fuel : null,
        dealer: typeof car.dealer === "string" ? car.dealer : null,
        vdp: typeof car.vdp === "string" ? car.vdp : null,
        reconUsd: null,
        estimatedDaysToSell: null,
        daysFlagged: false,
      });
    }
  }
  return out;
}

function runFrom(specCase: GoldenCase, json: Json, elapsedMs: number): GoldenRun {
  const need = json.need && typeof json.need === "object" ? (json.need as Record<string, unknown>) : null;
  const budget = typeof json.budgetUsd === "number" ? json.budgetUsd : typeof need?.budgetUsd === "number" ? need.budgetUsd : null;
  const queries = typeof json.providerQueriesUsed === "number" ? json.providerQueriesUsed : 0;
  const verdictRaw = json.verdictAction ?? (json.pickAgentVerdict as { verdict?: string } | undefined)?.verdict ?? null;
  const verdict = typeof verdictRaw === "string" ? verdictRaw : null;
  const confidenceRaw = typeof json.confidence === "string" ? json.confidence : null;
  const listings = listingsFrom(json);
  const best = json.best && typeof json.best === "object" ? (json.best as { vin?: string; reconUsd?: number; miles?: number }) : null;
  const hard = {
    ...(budget != null ? { priceMaxUsd: { value: budget, source: "form" as const } } : {}),
  };
  const draft = {
    v: 1 as const,
    mode: specCase.kind === "flip" ? ("flip" as const) : ("personal" as const),
    note: specCase.turns.find((turn) => "note" in turn)?.note ?? "",
    hard,
    enforced: {
      yearMin: typeof need?.yearMin === "number" ? need.yearMin : null,
      yearMax: null,
      milesMax: typeof need?.milesMax === "number" ? need.milesMax : null,
      priceMaxUsd: budget,
      zip: typeof need?.zip === "string" ? need.zip : null,
      radiusMi: typeof need?.distanceMiles === "number" ? need.distanceMiles : null,
    },
  };
  const charged = json.charged === true || json.chargedCredit === true;
  const message = typeof json.message === "string" ? json.message : null;
  const partial: Omit<GoldenRun, "final" | "elapsedMs"> = {
    caseId: specCase.id,
    specs: [{ ...draft, hash: sha256Canonical(draft) }],
    listings,
    providerQueriesUsed: queries,
    listingUrls: [],
    verdict,
    confidence: confidenceRaw === "High" || confidenceRaw === "Medium" || confidenceRaw === "Low" ? confidenceRaw : null,
    status: json.ok === false && /no credit/i.test(message ?? "") ? "stopped" : "ok",
    charged,
    pickVin: typeof best?.vin === "string" ? best.vin : listings[0]?.vin ?? null,
    proofRecords: Array.isArray(json.proofRecords) ? (json.proofRecords as GoldenRun["proofRecords"]) : [],
    buyer: {
      headline: typeof json.headline === "string" ? json.headline : null,
      message,
      nextStep: typeof json.nextStep === "string" ? json.nextStep : null,
      journal: [],
    },
    steps: [{ name: "live", elapsedMs, profileTimeoutMs: null, status: "ok" }],
    idempotencyKeys: [],
    replayedPriorDelivery: false,
    appliedTargetProfitUsd: typeof best?.reconUsd === "number" ? null : null,
    towing: "unknown",
    recordingsPending: false,
    unseenRequest: false,
    fuelPreference: null,
  };
  return {
    ...partial,
    elapsedMs,
    final: {
      pickVin: partial.pickVin,
      verdict: partial.verdict,
      confidence: partial.confidence,
      budgetUsd: budget,
      providerQueriesUsed: queries,
      listingVins: listings.map((car) => car.vin),
    },
  };
}

export async function runLiveCases(cases: readonly GoldenCase[], base: string, cookie: string): Promise<number> {
  let unexpected = 0;
  for (const specCase of cases) {
    const started = Date.now();
    const note = [...specCase.turns].reverse().find((turn) => "note" in turn);
    const text = note && "note" in note ? note.note : "";
    const personal = specCase.kind !== "flip";
    let json: Json = {};
    if (personal) {
      const planned = await post(base, cookie, "/api/need", {
        text,
        mode: "personal",
        budgetUsd: specCase.expect.budgetUsd ?? null,
        budgetKnown: specCase.expect.budgetUsd != null,
        zip: specCase.location === "nationwide" || specCase.location === "from-note" ? null : specCase.location.zip,
        distanceMiles: specCase.location === "nationwide" || specCase.location === "from-note" ? null : specCase.location.radiusMi,
      });
      const matched = await post(base, cookie, "/api/match", {
        need: planned.json.need,
        directions: planned.json.directions,
      });
      json = { ...planned.json, ...matched.json };
      const token = matched.json.searchContextToken;
      if (typeof token === "string" && matched.json.decidePathEnabled === true) {
        const decided = await post(base, cookie, "/api/find/decide", { searchContextToken: token });
        const verdict = decided.json.pickAgentVerdict as { verdict?: string; confidence?: string } | undefined;
        json = {
          ...json,
          verdictAction: verdict?.verdict ?? null,
          confidence: verdict?.confidence ?? null,
          proofRecords: decided.json.pickProofRecords,
        };
      }
    } else {
      const place =
        specCase.location === "nationwide" || specCase.location === "from-note"
          ? { zip: null, radiusMi: null }
          : specCase.location;
      const searched = await post(base, cookie, "/api/resale/search", {
        budgetUsd: specCase.expect.budgetUsd,
        zip: place.zip,
        distanceMiles: place.radiusMi,
        freeText: text,
        targetProfitUsd: null,
      });
      json = searched.json;
    }
    const run = runFrom(specCase, json, Date.now() - started);
    const failures = assertInvariants({ run, specCase, html: renderBuyerHtml(run), mode: "live" });
    const disposition: GateDisposition = dispositionFor(specCase.id, failures.map((row) => row.id));
    if (disposition === "unexpected") unexpected += 1;
    console.log(`\n${specCase.id}  ${disposition}`);
    for (const failure of failures) console.log(`  ${failure.id}: ${failure.message}`);
  }
  return unexpected > 0 ? 1 : 0;
}
