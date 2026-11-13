/**
 * One live capture, then two SERV decisions on that same snapshot.
 * Refuses to start unless EVAL_SNAPSHOT_ALLOW_PAID=1. Never prints secrets.
 *
 *   EVAL_SNAPSHOT_ALLOW_PAID=1 SERV_API_KEY=… AUTODEV_API_KEY=… npx tsx eval/snapshot/live-run.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { autodevSearch, autodevZipLookup } from "../../src/io/autodev";
import { TtlCache } from "../../src/io/cache";
import { MemoryCounter } from "../../src/io/quota";
import { readAccidentHistory } from "../../src/domain/accident-hard-constraint";
import {
  enrichListingDistanceFromCenter,
  enrichListingDistanceFromCentroidTable,
  stampRadiusCheck,
} from "../../src/domain/geo";
import { postServResponsesTurn } from "../../src/server/serv/agent-chat-turn";
import { buildAgentServFeatureBundle } from "../../src/server/serv/agent-serv-features";
import { scoreSnapshotDecision } from "./score";
import {
  costForDecision,
  criterionWinner,
  decisionRequestBody,
  modelFrom,
  parseSnapshotDecision,
  responseIdFrom,
} from "./live-decide";
import type { SearchSnapshot, SnapshotCandidate, SnapshotEvidence } from "./types";

const OUT_DIR = path.join(process.cwd(), "eval/results/compare-snapshot-2026-11-13");

const QUERY =
  "Denver 80202, $22k all-in, AWD SUV for mountain winters + 40-mile commute, two kids (safety first), under 90k miles, no accident/salvage, low fuel cost, within 75 miles, which to buy and what to offer";

const CRITERIA = [
  {
    id: "no_accident_primary",
    text: "The primary pick must not have accidentCount >= 1 or a title brand. If nothing clean fits, nothing-fits names the near misses.",
  },
  {
    id: "radius_when_known",
    text: "When distanceMiles is known, the primary pick must sit inside 75 miles. Unverified distance does not block.",
  },
  {
    id: "structured_offer",
    text: "If the decision prose names an offer, openingOffer or walkAway must be set.",
  },
];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function writeJson(name: string, value: unknown) {
  writeFileSync(path.join(OUT_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function capture(): Promise<SearchSnapshot> {
  const key = process.env.AUTODEV_API_KEY?.trim() ?? "";
  if (!key) fail("AUTODEV_API_KEY is not set. Refusing to search. No listing request was made.");
  const deps = {
    fetch,
    cache: new TtlCache<unknown>(),
    counter: new MemoryCounter(),
    apiKey: key,
    bypassCache: true,
  };
  const zip = await autodevZipLookup("80202", deps);
  const center = zip.ok
    ? { latitude: zip.location.latitude, longitude: zip.location.longitude }
    : null;
  const search = await autodevSearch(
    {
      bodyStyle: "SUV",
      priceRange: "1-22000",
      milesRange: "0-90000",
      used: true,
      zip: "80202",
      distanceMiles: 75,
      limit: 12,
    },
    deps,
  );
  if (!search.ok) {
    fail(`Listing search failed: ${search.error} status=${"status" in search ? search.status : "—"}. No SERV call was made.`);
  }
  const withCenter = enrichListingDistanceFromCenter(search.listings, center);
  const withTable = enrichListingDistanceFromCentroidTable(withCenter, "80202");
  const stamped = stampRadiusCheck(withTable);
  const candidates: SnapshotCandidate[] = [];
  for (const listing of stamped) {
    const vin = listing.vin?.trim().toUpperCase();
    if (!vin) continue;
    const history = readAccidentHistory({
      accidentCounts: [listing.accidentCount],
      texts: [listing.titleBrand, listing.usageType],
    });
    const titleBrand =
      listing.titleBrand?.trim() ||
      (history.kind === "violation" && /title brand/i.test(history.detail) ? history.detail : null);
    candidates.push({
      vin,
      year: listing.year,
      make: listing.make,
      model: listing.model,
      priceUsd: listing.priceUsd,
      miles: listing.miles,
      zip: listing.zip,
      city: listing.city,
      state: listing.state,
      distanceMiles: listing.distanceMiles ?? null,
      radiusCheck: listing.radiusCheck === "known" ? "known" : "unverified",
      accidentCount: listing.accidentCount ?? null,
      titleBrand,
    });
  }
  const evidence: SnapshotEvidence[] = [
    {
      source: "listing_feed",
      vin: null,
      status: candidates.length > 0 ? "queried_with_data" : "empty",
      note: `One Auto.dev search: used SUV, ask ≤ $22,000, miles ≤ 90,000, ZIP 80202, radius 75. Returned ${candidates.length} VINs. Buyer ZIP geocode ${zip.ok ? "ok" : "failed"}; dealer miles use listing coordinates or the bundled ZIP centroid table.`,
    },
    {
      source: "vehicle_history",
      vin: null,
      status: "not_attempted",
      note: "No paid history provider was called. accidentCount is the listing feed only. Missing history does not block.",
    },
  ];
  return {
    id: "denver-80202-frozen-2026-11-13",
    capturedAt: new Date().toISOString(),
    note: QUERY,
    buyerZip: "80202",
    radiusMi: 75,
    budgetUsd: 22000,
    hardConstraints: [
      { key: "budget", value: "$22,000 all-in" },
      { key: "body", value: "SUV" },
      { key: "drivetrain", value: "AWD" },
      { key: "mileage", value: "Under 90,000 miles" },
      { key: "history", value: "No accident or salvage history" },
      { key: "distance", value: "Within 75 miles of 80202" },
      { key: "use", value: "Mountain winters, 40-mile commute, two kids, safety first, low fuel cost" },
    ],
    candidates,
    evidence,
    criteria: CRITERIA,
  };
}

async function decide(snapshot: SearchSnapshot, servVerdictFeatures: "on" | "off") {
  const key = process.env.SERV_API_KEY?.trim() ?? "";
  if (!key) fail("SERV_API_KEY is not set. Refusing to call the model.");
  const bundle = buildAgentServFeatureBundle({
    product: "find",
    step: "verdict",
    includePromptGuard: servVerdictFeatures === "on",
    servVerdictFeatures,
  });
  const body = decisionRequestBody({ snapshot, servVerdictFeatures });
  const turn = await postServResponsesTurn({
    apiKey: key,
    baseUrl: process.env.SERV_BASE_URL,
    body,
  });
  const decision = turn.ok ? parseSnapshotDecision(turn.payload, servVerdictFeatures) : null;
  const cost = costForDecision(turn.payload, 1);
  return {
    servVerdictFeatures,
    ok: Boolean(turn.ok && decision),
    status: turn.status,
    error: turn.ok ? (decision ? null : "submit_picks missing") : turn.error ?? `http_${turn.status}`,
    responseId: responseIdFrom(turn.payload),
    model: modelFrom(turn.payload, bundle.model),
    requestedModel: bundle.model,
    latencyMs: turn.latencyMs,
    decision,
    cost,
  };
}

function candidateLine(snapshot: SearchSnapshot, vin: string | null): string {
  if (!vin) return "No primary pick.";
  const car = snapshot.candidates.find((row) => row.vin === vin.toUpperCase());
  if (!car) return `${vin} (not in the snapshot)`;
  const distance =
    car.distanceMiles != null ? `${car.distanceMiles} mi` : `radiusCheck ${car.radiusCheck}`;
  const accidents = car.accidentCount == null ? "accident history unverified" : `accidentCount ${car.accidentCount}`;
  return `${car.year} ${car.make} ${car.model} · ${vin} · ${distance} · ${accidents}`;
}

async function main() {
  if (process.env.EVAL_SNAPSHOT_ALLOW_PAID !== "1") {
    console.error("EVAL_SNAPSHOT_ALLOW_PAID is not 1. Refusing to search or call SERV.");
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  console.log("snapshot capture: one SUV search at 80202 / 75 mi / $22k / 90k miles");
  const snapshot = await capture();
  writeJson("snapshot.json", snapshot);
  console.log(`captured ${snapshot.candidates.length} candidates`);
  if (snapshot.candidates.length === 0) {
    fail("The one search returned no VINs. SERV was not called.");
  }

  const arms = [];
  for (const features of ["off", "on"] as const) {
    console.log(`decision servVerdictFeatures=${features} (no second search)`);
    const arm = await decide(snapshot, features);
    arms.push(arm);
    writeJson(`features-${features}.json`, arm);
    console.log(
      `features=${features} ok=${arm.ok} model=${arm.model} responseId=${arm.responseId ?? "—"} costSource=${arm.cost.source} usd=${arm.cost.usd ?? "—"}`,
    );
  }

  const scored = arms.map((arm) => ({
    ...arm,
    scores: arm.decision ? scoreSnapshotDecision(snapshot, arm.decision) : [],
  }));
  const off = scored.find((arm) => arm.servVerdictFeatures === "off");
  const on = scored.find((arm) => arm.servVerdictFeatures === "on");
  const criteria = CRITERIA.map((criterion) => {
    const offScore = off?.scores.find((row) => row.id === criterion.id);
    const onScore = on?.scores.find((row) => row.id === criterion.id);
    const winner = criterionWinner(Boolean(offScore?.pass), Boolean(onScore?.pass));
    return {
      id: criterion.id,
      label: criterion.text,
      features_off: offScore ?? null,
      features_on: onScore ?? null,
      winner,
      why:
        winner === "tie"
          ? `Both pass. Off: ${offScore?.detail ?? "—"} On: ${onScore?.detail ?? "—"}`
          : winner === "neither"
            ? `Neither passes. Off: ${offScore?.detail ?? "missing"} On: ${onScore?.detail ?? "missing"}`
            : winner === "features_off"
              ? `Features off passes (${offScore?.detail}). Features on: ${onScore?.detail ?? "missing"}.`
              : `Features on passes (${onScore?.detail}). Features off: ${offScore?.detail ?? "missing"}.`,
    };
  });

  function pickFacts(vin: string | null) {
    const car = vin ? snapshot.candidates.find((row) => row.vin === vin.toUpperCase()) : null;
    return {
      vin,
      label: candidateLine(snapshot, vin),
      accidentCount: car?.accidentCount ?? null,
      distanceMiles: car?.distanceMiles ?? null,
      radiusCheck: car?.radiusCheck ?? null,
    };
  }
  const checks = {
    neitherPickHasReportedAccident: scored.every((arm) => {
      const vin = arm.decision?.primaryVin;
      if (!vin) return true;
      const car = snapshot.candidates.find((row) => row.vin === vin);
      return !(car && car.accidentCount != null && car.accidentCount >= 1);
    }),
    bothHaveDistanceOrUnverified: scored.every((arm) => {
      const vin = arm.decision?.primaryVin;
      if (!vin) return true;
      const car = snapshot.candidates.find((row) => row.vin === vin);
      if (!car) return false;
      return car.distanceMiles != null || car.radiusCheck === "unverified";
    }),
    offerFieldsFilled: scored.every(
      (arm) => arm.decision != null && (arm.decision.openingOffer != null || arm.decision.walkAway != null),
    ),
  };

  const scores = {
    id: snapshot.id,
    query: QUERY,
    generatedAt: new Date().toISOString(),
    liveSearchCount: 1,
    note: "One listing search, then SERV decision features-off and features-on on that identical snapshot. Not two separate searches.",
    picks: {
      features_off: pickFacts(off?.decision?.primaryVin ?? null),
      features_on: pickFacts(on?.decision?.primaryVin ?? null),
    },
    offers: {
      features_off: {
        openingOffer: off?.decision?.openingOffer ?? null,
        walkAway: off?.decision?.walkAway ?? null,
        why: off?.decision?.why ?? null,
      },
      features_on: {
        openingOffer: on?.decision?.openingOffer ?? null,
        walkAway: on?.decision?.walkAway ?? null,
        why: on?.decision?.why ?? null,
      },
    },
    criteria,
    checks,
    cost: {
      features_off: off?.cost ?? null,
      features_on: on?.cost ?? null,
    },
    responseIds: {
      features_off: off?.responseId ?? null,
      features_on: on?.responseId ?? null,
    },
  };
  writeJson("scores.json", scores);
  console.log(`wrote ${OUT_DIR}`);
  const failed = scored.filter((arm) => !arm.ok);
  if (failed.length) {
    fail(`Decision failed for ${failed.map((arm) => arm.servVerdictFeatures).join(", ")}. Snapshot was still saved.`);
  }
}

const entry = process.argv[1]?.replace(/\\/g, "/");
if (entry?.endsWith("eval/snapshot/live-run.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "snapshot live run failed");
    process.exit(1);
  });
}
