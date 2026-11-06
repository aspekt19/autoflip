/**
 * Stage3 honest scout eval harness — machine-readable observables on fixed recorded data.
 *
 * - Real-source replay: fixtures/autodev-camry.json only (cited provenance).
 * - Adversarial: fixtures/scout/adversarial-contradiction.json (NOT live evidence).
 * - Mock/script planners prove CONTROL PLUMBING only — never SERV efficacy.
 * - Baseline = deterministic flip rank on same pool/budget (matched-data overlap, not quality).
 * - Timeout / refusal / abstain remain in the denominator.
 * - No observations → unknown (not 0-safety or perfect coverage).
 *
 * Usage: npx tsx eval/scout-baseline.ts
 * Exit 1 when observed unsafe claims or integrity perturbations fire on clean cases.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import camry from "../fixtures/autodev-camry.json";
import adversarial from "../fixtures/scout/adversarial-contradiction.json";
import { rankFlipCandidates } from "../src/domain/flip-rank";
import {
  REPLAY_CAMRY_PROVENANCE,
  detectTracePerturbations,
  mockServPlanner,
  observeScoutRun,
  refusingPlanner,
  replayInventoryAdapter,
  runScout,
  summarizeEvalInvariants,
  SCOUT_METRICS_SCHEMA_VERSION,
  type ScoutObservables,
  type PerturbationHit,
  type ScoutPlanAction,
  type ScoutRunResult,
} from "../src/domain/scout";
import { parseAutoDevListings } from "../src/io/parsers";

type CaseReport = {
  id: string;
  mode: "flip" | "personal";
  dataKind: "real_source_replay" | "synthetic_adversarial_NOT_live" | "control_refusal";
  provenance: string;
  plannerKind: "mock_script_control_plumbing_NOT_serv_efficacy" | "refusing_planner_NOT_serv";
  poolSize: number;
  baselineTopVins: string[];
  /** Explicit: matched-data overlap vs flip-rank baseline — plumbing, not SERV efficacy. */
  matchedDataBaselineNote: "MOCK_OFFLINE_identical_replay_overlap_NOT_serv_efficacy";
  observables: ScoutObservables;
  perturbations: PerturbationHit[];
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
  dataKind: CaseReport["dataKind"];
  withRejectReplace: boolean;
  refuse?: boolean;
}): Promise<CaseReport> {
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

  const scout: ScoutRunResult = await runScout({
    ownerId: `eval:${args.id}`,
    mandateRaw: mandate,
    inventory,
    planner: args.refuse ? refusingPlanner("serv_refused") : mockServPlanner(script),
    autonomyClaim: "none",
    budgets: { maxProviderCalls: 0, maxCandidatesOut: 5, maxServCalls: 30, maxToolCalls: 80 },
    now,
  });

  const observables = observeScoutRun(scout, {
    baselineTopVins: baseline,
    nowMs: Date.now(),
  });
  const perturbations = detectTracePerturbations(scout, {
    expectedInventorySource: "replay",
  });

  return {
    id: args.id,
    mode: args.mode,
    dataKind: args.dataKind,
    provenance: args.provenance,
    plannerKind: args.refuse
      ? "refusing_planner_NOT_serv"
      : "mock_script_control_plumbing_NOT_serv_efficacy",
    poolSize: pool.length,
    baselineTopVins: baseline,
    matchedDataBaselineNote: "MOCK_OFFLINE_identical_replay_overlap_NOT_serv_efficacy",
    observables,
    perturbations,
    notes: [
      "Mock/heuristic/refusing planners are NOT SERV efficacy evidence.",
      dataKindNote(args.dataKind),
      "Timeout/refusal/abstain remain in denominator; unknown ≠ 0-perfect.",
    ],
  };
}

function dataKindNote(kind: CaseReport["dataKind"]): string {
  if (kind === "synthetic_adversarial_NOT_live") return "Adversarial fixture is NOT live evidence.";
  if (kind === "control_refusal") return "Control refusal case — plumbing stop, not efficacy.";
  return REPLAY_CAMRY_PROVENANCE;
}

async function main() {
  const cases: CaseReport[] = [];

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

  // Denominator preservation: refusal is a first-class case, not dropped.
  cases.push(
    await runCase({
      id: "camry-flip-serv-refused",
      mode: "flip",
      raw: camry,
      provenance: REPLAY_CAMRY_PROVENANCE,
      dataKind: "control_refusal",
      withRejectReplace: false,
      refuse: true,
    }),
  );

  const invariants = summarizeEvalInvariants(
    cases.map((c) => ({ observables: c.observables, perturbations: c.perturbations })),
  );

  const beforeAfter = {
    before_tautologies_removed: [
      "claimsSafeBuyCount always 0 (type-forced literal false)",
      "insufficientEvidenceInvestigated under-defined / often 0",
      "realSourceAvailable: constant true",
      "rejectReplaceCovered: completed|abstained counted as covered",
      "completed ⇒ coverage / perfect when unobserved",
    ],
    after_observables: [
      "candidates.unsafeSafeBuyClaims observed|unknown",
      "candidates.historyUnknown / titleForbidOrWithhold",
      "evidence.byKind + bySource provenance counts",
      "gates.hardForbid|withhold|pass (unknown if none)",
      "tools.byStatus + inventorySearchAttempts",
      "actions.reject/replace + budget + latency.wallMs",
      "inventory.incomplete + terminalKind incl. timeout/refusal/abstain",
      "baselineOverlap matched-data only; labeling MOCK_OFFLINE",
      "detectTracePerturbations integrity suite",
    ],
  };

  const report = {
    harness: "eval/scout-baseline.ts",
    schemaVersion: SCOUT_METRICS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    note: "Stage3 honest observables. MOCK/OFFLINE plumbing only. Not SERV efficacy. No Guard/advantage claim.",
    beforeAfter,
    invariants,
    realSourcePath: "fixtures/autodev-camry.json",
    otherRealSourceSnapshots: "none — only autodev-camry.json exists in-repo; no invented provenance",
    cases,
  };

  const outPath = resolve(process.cwd(), "eval/results/scout-baseline.json");
  try {
    writeFileSync(outPath, JSON.stringify(report, null, 2));
  } catch {
    /* results dir may be gitignored; still print */
  }
  console.log(JSON.stringify(report, null, 2));

  const integrityFail =
    invariants.noObservedUnsafeSafeBuy === false ||
    invariants.noObservedUnsafeVerifiedProfit === false ||
    invariants.perturbationHitsTotal > 0;
  if (integrityFail) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
