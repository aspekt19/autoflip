/**
 * Baseline vs scout evaluation harness (offline).
 * Same candidate pool + budget. Mock / heuristic planners prove control plumbing only — never efficacy.
 * No live paid model calls. Proposed outcomes only — no fabricated scores.
 *
 * Usage: npx tsx eval/scout-baseline.ts
 */
import fixture from "../fixtures/autodev-camry.json";
import { rankFlipCandidates } from "../src/domain/flip-rank";
import {
  REPLAY_CAMRY_PROVENANCE,
  heuristicOfflinePlanner,
  replayInventoryAdapter,
  runScout,
} from "../src/domain/scout";
import { parseAutoDevListings } from "../src/io/parsers";

const mandate = {
  mode: "flip" as const,
  targetProfitUsd: 500,
  repairAbility: "unknown" as const,
  preferredMakes: ["Toyota"],
  openToOtherMakes: false,
  zip: "72712",
  maxDistanceMiles: 500,
  notes: null,
};

async function main() {
  const pool = parseAutoDevListings(fixture, "autodev");
  const now = new Date("2026-11-06T12:00:00Z");
  const baseline = rankFlipCandidates(pool, now, {
    repairAbility: mandate.repairAbility,
    targetProfitUsd: mandate.targetProfitUsd,
  })
    .filter((r) => !r.excluded)
    .slice(0, 5);

  const scout = await runScout({
    ownerId: "eval-harness",
    mandateRaw: mandate,
    inventory: replayInventoryAdapter(fixture, REPLAY_CAMRY_PROVENANCE),
    planner: heuristicOfflinePlanner(),
    autonomyClaim: "none",
    budgets: { maxProviderCalls: 0, maxCandidatesOut: 5, maxServCalls: 20, maxToolCalls: 60 },
    now,
  });

  const report = {
    provenance: REPLAY_CAMRY_PROVENANCE,
    note: "Proposed outcomes from offline replay — not efficacy scores. Held-out/tuning not mixed in.",
    sharedPoolSize: pool.length,
    budget: { maxCandidatesOut: 5, maxProviderCalls: 0 },
    baseline: {
      method: "rankFlipCandidates (deterministic asking-price comps)",
      count: baseline.length,
      vins: baseline.map((b) => b.vin),
    },
    scout: {
      method: "bounded loop + offline heuristic planner (autonomyClaim=none)",
      state: scout.state,
      failReason: scout.failReason,
      count: scout.investigation.length,
      vins: scout.investigation.map((c) => c.vin),
      usage: scout.usage,
    },
    lossesVisible: {
      baselineExcluded: rankFlipCandidates(pool, now, {
        repairAbility: mandate.repairAbility,
        targetProfitUsd: mandate.targetProfitUsd,
      }).filter((r) => r.excluded).length,
      scoutRejectedOrReplaced: scout.candidates.filter(
        (c) => c.disposition === "rejected" || c.disposition === "replaced",
      ).length,
      scoutPending: scout.candidates.filter((c) => c.disposition === "pending").length,
    },
    overlapVins: baseline
      .map((b) => b.vin)
      .filter((vin) => scout.investigation.some((c) => c.vin === vin)),
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
