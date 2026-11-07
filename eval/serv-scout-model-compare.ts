/**
 * Parent-runnable controlled SAME-input SERV-model comparison (owner t292).
 *
 * Rebuilds planner inputs from the sanitized PR63 placeholder ledger and, when
 * parent authorizes paid SERV, runs sequential scout_plan calls per model ID
 * from the in-repo catalog — strict JSON schema, scored for validity /
 * groundedness / recovery / latency / tokens / costunknown.
 *
 * This worker must not run paid calls. Defaults to dry-run (no network).
 *
 * Usage (parent):
 *   # Offline harness validation (no key, no spend):
 *   npm run eval:scout-model-compare
 *
 *   # Live sequential compare (parent only — spends SERV):
 *   SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 \\
 *     SERV_COMPARE_MODELS=gpt-5.4-mini,gpt-5.4-mini-2026-03-17 \\
 *     npm run eval:scout-model-compare
 *
 * Env (never print secret values):
 *   SERV_API_KEY              required for live mode
 *   SERV_BASE_URL             optional (default inference-api.openserv.ai/v1)
 *   SERV_COMPARE_MODELS      CSV of in-repo catalog IDs (default: all catalog)
 *   SCOUT_COMPARE_ALLOW_PAID  must be "1" to enable live SERV calls
 *   SCOUT_COMPARE_DRY_RUN     "1" forces dry-run even if key present
 *   SCOUT_COMPARE_OUT         optional output basename under eval/results/
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadPlaceholderLedger,
  prepareCompareStep,
  scoreHistoricalLedgerActions,
  scoreScoutPlanAction,
  PR63_PLACEHOLDER_LEDGER_PATH,
  type ActionScore,
} from "../src/domain/scout/serv-model-compare";
import { buildScoutPlanUserMessage } from "../src/server/scout/plan-user-message";
import { parseScoutPlanText } from "../src/server/scout/plan-parse";
import {
  listServCompareModels,
  resolveServCompareModelIds,
  servCompareCatalogNote,
  runServ,
  BASE_MODEL,
} from "../src/server/serv";
import { profile } from "../src/server/serv/profiles";

type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type ModelStepRow = {
  modelId: string;
  effectiveModel: string;
  stepId: string;
  schemaValid: boolean;
  score: ActionScore;
  latencyMs: number | null;
  tokens: Usage | null;
  cost: "unknown";
  rawStatus: number | null;
  reportedModel: string | null;
  error: string | null;
};

function usageFromProof(proof: unknown): Usage | null {
  if (!proof || typeof proof !== "object") return null;
  const openserv = (proof as { openserv?: { usage?: Usage } }).openserv;
  const u = openserv?.usage;
  if (!u || typeof u !== "object") return null;
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    total_tokens: u.total_tokens,
  };
}

function markdownReport(report: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("# SERV scout model compare (PR63 placeholder ledger)");
  lines.push("");
  lines.push(`- Mode: \`${String(report.mode)}\``);
  lines.push(`- Ledger: \`${PR63_PLACEHOLDER_LEDGER_PATH}\``);
  lines.push(`- Deployed SHA under test (ledger): \`${String(report.ledgerDeployedSha)}\``);
  lines.push(`- Cost: **unknown** (not reconciled; labeled costunknown)`);
  lines.push("");
  lines.push("## Catalog mechanism");
  lines.push("");
  lines.push("```");
  lines.push(servCompareCatalogNote());
  lines.push("```");
  lines.push("");
  lines.push("## Historical labeled actions (offline)");
  lines.push("");
  const hist = report.historicalScores as Array<{
    stepId: string;
    label: string;
    observedOutcomeOk: boolean;
    score: ActionScore;
  }>;
  for (const h of hist) {
    lines.push(
      `- ${h.stepId} (${h.label}): observedOk=${h.observedOutcomeOk}; recovery=${h.score.recoveryClass}; grounded=${h.score.grounded}; antiLoopSafe=${h.score.antiLoopSafe}`,
    );
  }
  lines.push("");
  lines.push("## Model × step rows");
  lines.push("");
  const rows = report.rows as ModelStepRow[];
  if (!rows.length) {
    lines.push("_No live model rows (dry-run)._");
  } else {
    for (const r of rows) {
      lines.push(
        `- **${r.modelId}** @ \`${r.stepId}\`: schemaValid=${r.schemaValid}; recovery=${r.score.recoveryClass}; grounded=${r.score.grounded}; antiLoopSafe=${r.score.antiLoopSafe}; latencyMs=${r.latencyMs ?? "n/a"}; tokens=${r.tokens?.total_tokens ?? "n/a"}; cost=unknown${r.error ? `; error=${r.error}` : ""}`,
      );
    }
  }
  lines.push("");
  lines.push(
    "Not a production default-model swap. Parent chooses and executes sequential live comparisons.",
  );
  return lines.join("\n");
}

async function main() {
  const dryForced = process.env.SCOUT_COMPARE_DRY_RUN === "1";
  const allowPaid = process.env.SCOUT_COMPARE_ALLOW_PAID === "1";
  const key = process.env.SERV_API_KEY?.trim() ?? "";
  const live = !dryForced && allowPaid && Boolean(key);

  if (!dryForced && allowPaid && !key) {
    console.error(
      "SCOUT_COMPARE_ALLOW_PAID=1 but SERV_API_KEY is missing. Refusing to call SERV. Export the key or omit ALLOW_PAID for dry-run.",
    );
    process.exit(1);
  }
  if (!dryForced && key && !allowPaid) {
    console.error(
      "SERV_API_KEY is set but SCOUT_COMPARE_ALLOW_PAID is not 1. Defaulting to dry-run (no spend). Set SCOUT_COMPARE_ALLOW_PAID=1 to run live sequential compares.",
    );
  }

  const modelRes = resolveServCompareModelIds(process.env.SERV_COMPARE_MODELS);
  if (!modelRes.ok) {
    console.error(modelRes.message);
    process.exit(1);
  }

  const ledger = loadPlaceholderLedger();
  const historicalScores = scoreHistoricalLedgerActions(ledger);
  const preparedSteps = ledger.compareSteps.map((s) => prepareCompareStep(ledger, s));

  const stepUserMessages = preparedSteps.map((p) => ({
    stepId: p.stepId,
    userMessageBytes: Buffer.byteLength(buildScoutPlanUserMessage(p.plannerInput), "utf8"),
    pendingCount: p.plannerInput.pendingVins.length,
    usableAsks: p.plannerInput.evidenceContext.pendingAskSummary.usableAskingPriceCount,
    allUnusable: p.plannerInput.evidenceContext.pendingAskSummary.allPendingAskingPricesUnusable,
  }));

  const scoutProfile = profile("scout_plan");
  const rows: ModelStepRow[] = [];

  if (live) {
    console.log(servCompareCatalogNote());
    console.log(
      `Live sequential compare: ${modelRes.models.length} model(s) × ${preparedSteps.length} step(s). Cost unknown until central reconciliation.`,
    );
    for (const model of modelRes.models) {
      for (const prepared of preparedSteps) {
        const user = buildScoutPlanUserMessage(prepared.plannerInput);
        const started = Date.now();
        let latencyMs: number | null = null;
        let tokens: Usage | null = null;
        let rawStatus: number | null = null;
        let reportedModel: string | null = null;
        let error: string | null = null;
        let schemaValid = false;
        let score: ActionScore;

        try {
          const result = await runServ(
            "scout_plan",
            { user },
            {
              apiKey: key,
              baseUrl: process.env.SERV_BASE_URL,
              model: model.id,
              timeoutMs: scoutProfile.timeoutMs,
            },
          );
          latencyMs = Date.now() - started;
          tokens = usageFromProof(result.proof);
          reportedModel = result.proof.modelReported || null;

          if (!result.ok) {
            rawStatus = result.status;
            error = result.error;
            score = scoreScoutPlanAction({
              action: null,
              schemaValid: false,
              parseKind: "serv_error",
              candidatesByVin: prepared.candidatesByVin,
              recentOutcomes: prepared.plannerInput.recentOutcomes,
              priorDeniedRejectFingerprint: prepared.priorDeniedRejectFingerprint,
            });
          } else {
            rawStatus = result.rawStatus;
            const parsed = parseScoutPlanText(result.text);
            schemaValid = parsed.ok;
            score = scoreScoutPlanAction({
              action: parsed.ok ? parsed.action : null,
              schemaValid: parsed.ok,
              parseKind: parsed.ok ? null : parsed.kind,
              candidatesByVin: prepared.candidatesByVin,
              recentOutcomes: prepared.plannerInput.recentOutcomes,
              priorDeniedRejectFingerprint: prepared.priorDeniedRejectFingerprint,
            });
            if (!parsed.ok) error = `${parsed.kind}: ${parsed.message}`;
          }
        } catch (err) {
          latencyMs = Date.now() - started;
          error = err instanceof Error ? err.message : "unknown_throw";
          score = scoreScoutPlanAction({
            action: null,
            schemaValid: false,
            parseKind: "throw",
            candidatesByVin: prepared.candidatesByVin,
            recentOutcomes: prepared.plannerInput.recentOutcomes,
            priorDeniedRejectFingerprint: prepared.priorDeniedRejectFingerprint,
          });
        }

        rows.push({
          modelId: model.id,
          effectiveModel: model.effectiveForScoutPlan,
          stepId: prepared.stepId,
          schemaValid,
          score,
          latencyMs,
          tokens,
          cost: "unknown",
          rawStatus,
          reportedModel,
          error,
        });
        console.log(
          `${model.id} @ ${prepared.stepId}: schemaValid=${schemaValid} recovery=${score.recoveryClass} latencyMs=${latencyMs} cost=unknown`,
        );
      }
    }
  } else {
    console.log("Dry-run: no SERV/Auto.dev calls. Historical ledger scores + catalog only.");
    console.log(servCompareCatalogNote());
  }

  const report = {
    schemaVersion: "serv-scout-model-compare/v1",
    mode: live ? "live_sequential" : "dry_run",
    harness: "eval/serv-scout-model-compare.ts",
    ledgerPath: PR63_PLACEHOLDER_LEDGER_PATH,
    ledgerLabel: ledger.label,
    ledgerDeployedSha: ledger.deployedSha,
    ledgerRunId: ledger.runId,
    productionDefaultModel: BASE_MODEL,
    productionDefaultUnchanged: true,
    strictJsonSchema: Boolean(scoutProfile.jsonSchema),
    catalog: listServCompareModels(),
    modelsSelected: modelRes.models,
    stepUserMessages,
    historicalScores,
    rows,
    cost: "unknown" as const,
    notes: [
      ...ledger.notes,
      "Parent sole live coordinator — Cursor worker must not set SCOUT_COMPARE_ALLOW_PAID.",
      "Repeated-action / evidence guards are scored, not weakened.",
      "Not a claim that any model beats another until parent runs live rows.",
    ],
  };

  const outName = process.env.SCOUT_COMPARE_OUT?.trim() || "serv-scout-model-compare";
  const outJson = resolve(process.cwd(), "eval/results", `${outName}.json`);
  const outMd = resolve(process.cwd(), "eval/results", `${outName}.md`);
  mkdirSync(resolve(process.cwd(), "eval/results"), { recursive: true });
  writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(outMd, `${markdownReport(report)}\n`);
  console.log(`Wrote ${outJson}`);
  console.log(`Wrote ${outMd}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
