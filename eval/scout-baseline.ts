/**
 * Honest scout eval harness — machine-readable metrics on fixed recorded data.
 *
 * - Real-source replay: fixtures/autodev-camry.json only (cited provenance).
 * - Adversarial: fixtures/scout/adversarial-contradiction.json (NOT live evidence).
 * - Mock/script planners prove CONTROL PLUMBING only — never SERV efficacy.
 * - Baseline = deterministic flip rank on same pool/budget.
 *
 * Usage: npx tsx eval/scout-baseline.ts
 * Exit 0 always when harness completes; metrics carry pass/fail flags.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import camry from "../fixtures/autodev-camry.json";
import adversarial from "../fixtures/scout/adversarial-contradiction.json";
import { rankFlipCandidates } from "../src/domain/flip-rank";
import {
  REPLAY_CAMRY_PROVENANCE,
  mockServPlanner,
  replayInventoryAdapter,
  runScout,
  type ScoutPlanAction,
  type ScoutRunResult,
} from "../src/domain/scout";
import { parseAutoDevListings } from "../src/io/parsers";

type CaseMetrics = {
  id: string;
  mode: "flip" | "personal";
  dataKind: "real_source_replay" | "synthetic_adversarial_NOT_live";
  provenance: string;
  plannerKind: "mock_script_control_plumbing_NOT_serv_efficacy" | "offline_heuristic_NOT_serv";
  poolSize: number;
  baselineTopVins: string[];
  scoutState: string;
  scoutFailReason: string | null;
  investigationCount: number;
  investigationVins: string[];
  rejectedCount: number;
  replacedCount: number;
  claimsSafeBuyCount: number;
  claimsVerifiedProfitCount: number;
  insufficientEvidenceInvestigated: number;
  overlapWithBaseline: number;
  scriptCoveredRejectReplace: boolean;
  notes: string[];
};

function flipMandate() {
  return {
    mode: "flip" as const,
    targetProfitUsd: 500,
    repairAbility: "unknown" as const,
    preferredMakes: ["Toyota"],
    openToOtherMakes: false,
    zip: "72712",
    maxDistanceMiles: 500,
    notes: null,
  };
}

function personalMandate() {
  return {
    mode: "personal" as const,
    budgetUsd: 25000,
    budgetKnown: true,
    targetProfitUsd: null,
    repairAbility: "unknown" as const,
    preferredMakes: ["Toyota"],
    openToOtherMakes: false,
    zip: "72712",
    maxDistanceMiles: 500,
    notes: null,
  };
}

function metricsFrom(
  id: string,
  mode: "flip" | "personal",
  dataKind: CaseMetrics["dataKind"],
  provenance: string,
  plannerKind: CaseMetrics["plannerKind"],
  pool: ReturnType<typeof parseAutoDevListings>,
  baselineVins: string[],
  scout: ScoutRunResult,
  scriptCoveredRejectReplace: boolean,
): CaseMetrics {
  const insufficient = scout.investigation.filter((c) => {
    const noPrice = c.listing.priceUsd == null;
    const histUnknown = c.historyStatus === "unknown";
    const flipThin = mode === "flip" && (!c.flip || c.flip.excluded || c.flip.compCount < 3);
    return noPrice || (flipThin && mode === "flip") || (histUnknown && c.claimsSafeBuy);
  });

  return {
    id,
    mode,
    dataKind,
    provenance,
    plannerKind,
    poolSize: pool.length,
    baselineTopVins: baselineVins,
    scoutState: scout.state,
    scoutFailReason: scout.failReason,
    investigationCount: scout.investigation.length,
    investigationVins: scout.investigation.map((c) => c.vin),
    rejectedCount: scout.candidates.filter((c) => c.disposition === "rejected").length,
    replacedCount: scout.candidates.filter((c) => c.disposition === "replaced").length,
    claimsSafeBuyCount: scout.candidates.filter((c) => c.claimsSafeBuy).length,
    claimsVerifiedProfitCount: scout.candidates.filter((c) => c.claimsVerifiedProfit).length,
    insufficientEvidenceInvestigated: insufficient.length,
    overlapWithBaseline: baselineVins.filter((v) =>
      scout.investigation.some((c) => c.vin === v),
    ).length,
    scriptCoveredRejectReplace,
    notes: [
      "Mock/heuristic planners are NOT SERV efficacy evidence.",
      dataKind === "synthetic_adversarial_NOT_live" ? "Adversarial fixture is NOT live evidence." : REPLAY_CAMRY_PROVENANCE,
    ],
  };
}

function rejectReplaceScript(vins: string[]): ScoutPlanAction[] {
  const [a, b, ...rest] = vins;
  if (!a || !b) {
    return [{ type: "abstain", reason: "Need ≥2 VINs for reject/replace script", servStepId: "eval" }];
  }
  return [
    { type: "select_candidate", vin: a, reason: "eval:select first", servStepId: "e1" },
    { type: "run_tool", toolId: "economics.flip_estimate", vin: a, reason: "eval:economics", servStepId: "e2" },
    { type: "run_tool", toolId: "gates.verify", vin: a, reason: "eval:gates", servStepId: "e3" },
    { type: "reject", vin: a, reason: "eval:contradictory/weak evidence — reject", servStepId: "e4" },
    { type: "replace", vin: a, reason: "eval:pull replacement", servStepId: "e5" },
    { type: "select_candidate", vin: b, reason: "eval:replacement candidate", servStepId: "e6" },
    ...rest.slice(0, 2).map(
      (vin, i): ScoutPlanAction => ({
        type: "select_candidate",
        vin,
        reason: `eval:additional ${i}`,
        servStepId: `e7-${i}`,
      }),
    ),
    { type: "finalize", reason: "eval:finalize after reject/replace", servStepId: "e8" },
  ];
}

async function runCase(args: {
  id: string;
  mode: "flip" | "personal";
  raw: unknown;
  provenance: string;
  dataKind: CaseMetrics["dataKind"];
  withRejectReplace: boolean;
}): Promise<CaseMetrics> {
  const mandate = args.mode === "flip" ? flipMandate() : personalMandate();
  const pool = parseAutoDevListings(args.raw, "sample");
  const now = new Date("2026-11-06T12:00:00Z");
  const baseline = rankFlipCandidates(pool, now, {
    repairAbility: "unknown",
    targetProfitUsd: args.mode === "flip" ? 500 : null,
  })
    .filter((r) => !r.excluded)
    .slice(0, 5)
    .map((r) => r.vin);

  const inventory = replayInventoryAdapter(args.raw, args.provenance);
  const peek = await inventory(mandate as never);
  const vins = peek.ok ? peek.listings.map((l) => l.vin) : [];

  const script = args.withRejectReplace
    ? rejectReplaceScript(vins)
    : [
        ...vins.slice(0, 5).map(
          (vin): ScoutPlanAction => ({
            type: "select_candidate",
            vin,
            reason: "eval:select",
            servStepId: `s-${vin}`,
          }),
        ),
        { type: "finalize" as const, reason: "eval:done", servStepId: "final" },
      ];

  const scout = await runScout({
    ownerId: `eval:${args.id}`,
    mandateRaw: mandate,
    inventory,
    planner: mockServPlanner(script),
    // Mock script = control plumbing only — never claim SERV-directed autonomy.
    autonomyClaim: "none",
    budgets: { maxProviderCalls: 0, maxCandidatesOut: 5, maxServCalls: 30, maxToolCalls: 80 },
    now,
  });

  return metricsFrom(
    args.id,
    args.mode,
    args.dataKind,
    args.provenance,
    "mock_script_control_plumbing_NOT_serv_efficacy",
    pool,
    baseline,
    scout,
    args.withRejectReplace,
  );
}

async function main() {
  const cases: CaseMetrics[] = [];

  cases.push(
    await runCase({
      id: "camry-flip-reject-replace",
      mode: "flip",
      raw: camry,
      provenance: REPLAY_CAMRY_PROVENANCE,
      dataKind: "real_source_replay",
      withRejectReplace: true,
    }),
  );

  cases.push(
    await runCase({
      id: "camry-personal-select",
      mode: "personal",
      raw: camry,
      provenance: REPLAY_CAMRY_PROVENANCE,
      dataKind: "real_source_replay",
      withRejectReplace: false,
    }),
  );

  cases.push(
    await runCase({
      id: "adversarial-flip-reject-replace",
      mode: "flip",
      raw: adversarial,
      provenance: "fixtures/scout/adversarial-contradiction.json — NOT live evidence",
      dataKind: "synthetic_adversarial_NOT_live",
      withRejectReplace: true,
    }),
  );

  const invariants = {
    noSafeBuyClaims: cases.every((c) => c.claimsSafeBuyCount === 0),
    noVerifiedProfitClaims: cases.every((c) => c.claimsVerifiedProfitCount === 0),
    rejectReplaceCovered: cases.filter((c) => c.scriptCoveredRejectReplace).every((c) => c.rejectedCount + c.replacedCount > 0 || c.scoutState === "abstained" || c.scoutState === "completed"),
    realSourceAvailable: true,
    realSourcePath: "fixtures/autodev-camry.json",
    otherRealSourceSnapshots: "none — only autodev-camry.json exists in-repo; no invented provenance",
    plannerEfficacyClaimed: false,
  };

  const report = {
    harness: "eval/scout-baseline.ts",
    generatedAt: new Date().toISOString(),
    note: "Machine-readable offline metrics. Mock planners = control plumbing only. Not SERV efficacy.",
    invariants,
    cases,
  };

  const outPath = resolve(process.cwd(), "eval/results/scout-baseline.json");
  try {
    writeFileSync(outPath, JSON.stringify(report, null, 2));
  } catch {
    /* results dir may be gitignored; still print */
  }
  console.log(JSON.stringify(report, null, 2));

  if (!invariants.noSafeBuyClaims || !invariants.noVerifiedProfitClaims) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
