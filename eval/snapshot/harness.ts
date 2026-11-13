/**
 * Frozen-snapshot eval runner.
 *
 * Default (no EVAL_SNAPSHOT_ALLOW_PAID) does not call SERV or a listing API.
 * A later paid run can pass decide() that calls the verdict hop with
 * servVerdictFeatures off and on against this same snapshot.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { readProviderCost, scoreSnapshotDecision } from "./score";
import type {
  SearchSnapshot,
  SnapshotArmDecision,
  SnapshotArmResult,
  SnapshotEvalResult,
} from "./types";

export type SnapshotDecide = (input: {
  snapshot: SearchSnapshot;
  servVerdictFeatures: "on" | "off";
}) => Promise<
  | { ok: true; decision: SnapshotArmDecision; payload?: unknown }
  | { ok: false; reason: string }
>;

const FIXTURE = path.join(process.cwd(), "eval/snapshot/fixture.json");

export function loadSnapshotFixture(file = FIXTURE): SearchSnapshot {
  return JSON.parse(readFileSync(file, "utf8")) as SearchSnapshot;
}

/** Capture one search's candidates and evidence. Does not call a provider. */
export function captureSearchSnapshot(snapshot: SearchSnapshot): SearchSnapshot {
  return {
    ...snapshot,
    candidates: snapshot.candidates.map((row) => ({ ...row })),
    evidence: snapshot.evidence.map((row) => ({ ...row })),
    criteria: snapshot.criteria.map((row) => ({ ...row })),
    hardConstraints: snapshot.hardConstraints.map((row) => ({ ...row })),
  };
}

export async function compareSnapshotArms(input: {
  snapshot: SearchSnapshot;
  decide: SnapshotDecide;
}): Promise<SnapshotEvalResult> {
  const snapshot = captureSearchSnapshot(input.snapshot);
  const vins = snapshot.candidates.map((row) => row.vin);
  const arms: SnapshotArmResult[] = [];
  for (const servVerdictFeatures of ["off", "on"] as const) {
    const outcome = await input.decide({ snapshot, servVerdictFeatures });
    if (!outcome.ok) {
      arms.push({
        servVerdictFeatures,
        status: "not_run",
        reason: outcome.reason,
        scores: [],
        providerCost: readProviderCost(null),
      });
      continue;
    }
    arms.push({
      servVerdictFeatures,
      status: "scored",
      decision: outcome.decision,
      scores: scoreSnapshotDecision(snapshot, outcome.decision),
      providerCost: readProviderCost(outcome.payload),
    });
  }
  return {
    snapshotId: snapshot.id,
    candidateVins: vins,
    liveSearch: false,
    arms,
  };
}

/** Paid comparison stays off unless a later run sets the gate. This process does not call it. */
export function liveSnapshotDecide(): SnapshotDecide {
  return async ({ servVerdictFeatures }) => {
    if (process.env.EVAL_SNAPSHOT_ALLOW_PAID !== "1") {
      return {
        ok: false,
        reason: `servVerdictFeatures=${servVerdictFeatures} not run — set EVAL_SNAPSHOT_ALLOW_PAID=1 after merge. No live search.`,
      };
    }
    return {
      ok: false,
      reason: "Paid snapshot decision is not invoked from this commit.",
    };
  };
}

async function main() {
  const snapshot = loadSnapshotFixture();
  const result = await compareSnapshotArms({
    snapshot,
    decide: liveSnapshotDecide(),
  });
  console.log(JSON.stringify(result, null, 2));
}

const entry = process.argv[1]?.replace(/\\/g, "/");
if (entry?.endsWith("eval/snapshot/harness.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "snapshot eval failed");
    process.exit(1);
  });
}
