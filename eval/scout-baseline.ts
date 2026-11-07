/**
 * Stage3 residue harness — scout-metrics/v2 observables on fixed recorded data.
 *
 * MOCK/OFFLINE plumbing only — never SERV efficacy / safety certification.
 * Exit 0 = plumbing integrity only (clearly separated from evidenceComplete/safetyCertified).
 *
 * Usage: npx tsx eval/scout-baseline.ts
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
  type ScoutPlanner,
} from "../src/domain/scout";
import { parseAutoDevListings } from "../src/io/parsers";

type CaseReport = {
  id: string;
  mode: "flip" | "personal";
  dataKind:
    | "real_source_replay"
    | "synthetic_adversarial_NOT_live"
    | "control_refusal"
    | "control_timeout"
    | "control_abstain"
    | "control_parse_fail";
  provenance: string;
  plannerKind:
    | "mock_script_control_plumbing_NOT_serv_efficacy"
    | "refusing_planner_NOT_serv"
    | "timeout_planner_NOT_serv"
    | "parse_fail_planner_NOT_serv";
  poolSize: number;
  baselineTopVins: string[];
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
    maxMiles: null,
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
    maxMiles: null,
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

function parseFailPlanner(): ScoutPlanner {
  return async () => ({
    ok: false,
    error: "serv_unavailable",
    message: "SERV planner schema_mismatch: missing reason — parse failure control case.",
  });
}

async function runCase(args: {
  id: string;
  mode: "flip" | "personal";
  raw: unknown;
  provenance: string;
  dataKind: CaseReport["dataKind"];
  withRejectReplace: boolean;
  refuse?: boolean;
  timeout?: boolean;
  parseFail?: boolean;
  forceAbstainScript?: boolean;
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

  const script = args.forceAbstainScript
    ? [{ type: "abstain" as const, reason: "eval:explicit abstain control", servStepId: "abs" }]
    : args.withRejectReplace
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

  let planner: ScoutPlanner = mockServPlanner(script);
  let plannerKind: CaseReport["plannerKind"] = "mock_script_control_plumbing_NOT_serv_efficacy";
  if (args.refuse) {
    planner = refusingPlanner("serv_refused");
    plannerKind = "refusing_planner_NOT_serv";
  } else if (args.timeout) {
    planner = refusingPlanner("serv_timeout");
    plannerKind = "timeout_planner_NOT_serv";
  } else if (args.parseFail) {
    planner = parseFailPlanner();
    plannerKind = "parse_fail_planner_NOT_serv";
  }

  const scout: ScoutRunResult = await runScout({
    ownerId: `eval:${args.id}`,
    mandateRaw: mandate,
    inventory,
    planner,
    autonomyClaim: "none",
    budgets: { maxProviderCalls: 0, maxCandidatesOut: 5, maxServCalls: 30, maxToolCalls: 80 },
    now,
  });

  const expect = {
    requireInventorySearch: true,
    requireToolOutcomes: true,
    requireUsageBudgets: true,
    expectedInventorySource: "replay" as const,
    expectedFixture: true,
  };

  const observables = observeScoutRun(scout, {
    baselineTopVins: baseline,
    expect,
  });
  const perturbations = detectTracePerturbations(scout, expect);

  return {
    id: args.id,
    mode: args.mode,
    dataKind: args.dataKind,
    provenance: args.provenance,
    plannerKind,
    poolSize: pool.length,
    baselineTopVins: baseline,
    matchedDataBaselineNote: "MOCK_OFFLINE_identical_replay_overlap_NOT_serv_efficacy",
    observables,
    perturbations,
    notes: [
      "Mock/heuristic/refusing planners are NOT SERV efficacy evidence.",
      "safetyCertified=false always; evidenceComplete is separate from plumbingOk.",
      "Timeout/refusal/abstain/parse stay in denominator; unknown ≠ 0-perfect.",
    ],
  };
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

  cases.push(
    await runCase({
      id: "camry-flip-serv-timeout",
      mode: "flip",
      raw: camry,
      provenance: REPLAY_CAMRY_PROVENANCE,
      dataKind: "control_timeout",
      withRejectReplace: false,
      timeout: true,
    }),
  );

  cases.push(
    await runCase({
      id: "camry-flip-explicit-abstain",
      mode: "flip",
      raw: camry,
      provenance: REPLAY_CAMRY_PROVENANCE,
      dataKind: "control_abstain",
      withRejectReplace: false,
      forceAbstainScript: true,
    }),
  );

  cases.push(
    await runCase({
      id: "camry-flip-parse-fail",
      mode: "flip",
      raw: camry,
      provenance: REPLAY_CAMRY_PROVENANCE,
      dataKind: "control_parse_fail",
      withRejectReplace: false,
      parseFail: true,
    }),
  );

  const invariants = summarizeEvalInvariants(
    cases.map((c) => ({ observables: c.observables, perturbations: c.perturbations })),
  );

  const report = {
    harness: "eval/scout-baseline.ts",
    schemaVersion: SCOUT_METRICS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    note: "Stage3-residue-followon scout-metrics/v3. MOCK/OFFLINE plumbing only. Not SERV efficacy. safetyCertified always false.",
    certification: {
      safetyCertified: false as const,
      servEfficacyClaimed: false as const,
      plumbingOk: invariants.plumbingOk,
      evidenceCompleteCases: invariants.evidenceCompleteCases,
      traceCompleteCases: invariants.traceCompleteCases,
      decisionEvidenceCompleteCases: invariants.decisionEvidenceCompleteCases,
      note: "Exit 0 reflects plumbing integrity only — not TRACE/decision evidence or safety certification.",
    },
    invariants,
    realSourcePath: "fixtures/autodev-camry.json",
    otherRealSourceSnapshots: "none — only autodev-camry.json exists in-repo; no invented provenance",
    cases,
  };

  const outPath = resolve(process.cwd(), "eval/results/scout-baseline.json");
  try {
    writeFileSync(outPath, JSON.stringify(report, null, 2));
  } catch {
    /* still print */
  }
  console.log(JSON.stringify(report, null, 2));

  // Plumbing exit: integrity perturbations / observed unsafe claims fail the process.
  // evidenceComplete incomplete on control fail cases is expected — not an exit failure by itself.
  if (!invariants.plumbingOk || invariants.noObservedUnsafeSafeBuy === false) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
