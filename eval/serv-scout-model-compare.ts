/**
 * Parent-runnable controlled SAME-input SERV-model comparison (owner t292/t294/t295/t296).
 *
 * Rebuilds planner inputs from the sanitized PR63 placeholder ledger and, when
 * parent authorizes paid SERV, runs sequential scout_plan calls per model ID —
 * strict JSON schema, scored for validity / groundedness / recovery / latency /
 * tokens / costunknown.
 *
 * Live transport uses `experiment_single_attempt` (one HTTP per step; empty/timeout
 * recorded, not silently re-POSTed). Production planner recovery retries are unchanged.
 *
 * ## Not a demonstrated product fix via model swap
 * This harness enables parent comparison only. A model-only swap is **NOT** the
 * demonstrated fix for the PR63 placeholder-price / reject-grounding deadlock.
 * Production `BASE_MODEL` / `SERV_MODEL` default is unchanged.
 *
 * ## Network / spend gates (confirm)
 * Default = zero network (dry-run). Live SERV requires both:
 *   SERV_API_KEY + SCOUT_COMPARE_ALLOW_PAID=1
 * (SCOUT_COMPARE_DRY_RUN=1 forces dry-run even if a key is present.)
 *
 * ## Console vs in-repo catalog
 * OpenServ console Available-models (owner screenshots) lists broader IDs and
 * $/M rates (e.g. gpt-6-luna). In-repo catalog stays narrow. Parent may pass
 * explicit IDs after console/contract validation with
 * SCOUT_COMPARE_ALLOW_UNLISTED=1. Fail-closed for garbage. Do not force cheapest;
 * budget-conscious ≠ cheapest-at-expense-of-quality.
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
 *   # Parent-validated console ID not in in-repo catalog:
 *   SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_ALLOW_UNLISTED=1 \\
 *     SERV_COMPARE_MODELS=gpt-6-luna \\
 *     npm run eval:scout-model-compare
 *
 * Env (never print secret values):
 *   SERV_API_KEY                 required for live mode
 *   SERV_BASE_URL                optional (default inference-api.openserv.ai/v1)
 *   SERV_COMPARE_MODELS         CSV (default: in-repo catalog)
 *   SCOUT_COMPARE_ALLOW_PAID     must be "1" to enable live SERV calls
 *   SCOUT_COMPARE_ALLOW_UNLISTED must be "1" to accept non-catalog model IDs
 *   SCOUT_COMPARE_DRY_RUN        "1" forces dry-run even if key present
 *   SCOUT_COMPARE_SEQUENTIAL     "1" enables parent live ≤2-decision sequential probe
 *                                XOR with normal compare: when set + paid live gates,
 *                                ONLY sequential runs (no normal model×steps rows).
 *                                (default dry-run still exercises offline sequential fixture)
 *   SCOUT_COMPARE_SOURCE_PIN     optional JSON object attested into report.sourcePin
 *                                (absent/invalid → null; never invent head/tree)
 *   SCOUT_COMPARE_OUT            optional output basename under eval/results/
 *
 * Sequential TWO-decision (experimental; separate from production defaults):
 *   Decision-1 on after_inventory_before_reject → local apply (production disposition
 *   validation/reducer, no network) → Decision-2 on offline_replay_after_local_apply.
 *   Max 2 experiment_single_attempt HTTP total across the FULL CLI invocation when
 *   sequential opt-in is set (normal compare is skipped). Timeout 45s; tokens 4096;
 *   no silent retries. Decision-2 is NOT live tool-result / full-cycle. Default zero HTTP.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadPlaceholderLedger,
  offlineFixtureGroundedReject,
  prepareCompareStep,
  retainScoutPlanAction,
  runOfflineSequentialTwoDecision,
  scoreHistoricalLedgerActions,
  scoreScoutPlanAction,
  PR63_PLACEHOLDER_LEDGER_PATH,
  type ActionScore,
  type RetainedScoutPlanAction,
  type SequentialTwoDecisionResult,
} from "../src/domain/scout/serv-model-compare";
import { buildScoutPlanUserMessage } from "../src/server/scout/plan-user-message";
import {
  parseScoutPlanText,
  sanitizePlannerParseEcho,
  type SanitizedPlannerParseEcho,
} from "../src/server/scout/plan-parse";
import { normalizeCompareUsage } from "../src/server/scout/plan-parse-diagnostics";
import { runSequentialCompareProbe } from "../src/server/scout/sequential-compare-probe";
import {
  executeCompareCliPaidPath,
  resolveCompareCliDispatch,
  resolveCompareSourcePin,
} from "../src/server/scout/compare-cli-dispatch";
import {
  listServCompareModels,
  resolveServCompareModelIds,
  servCompareCatalogNote,
  experimentServDeps,
  runServ,
  BASE_MODEL,
  SERV_OUTPUT_TOKEN_DEFAULT,
  resolveServOutputTokenBound,
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
  unlistedOptIn: boolean;
  /** Upstream SERV HTTP dispatches for this step (experiment: expect 1). */
  httpAttempts: number | null;
  transportPolicy: "experiment_single_attempt" | null;
  /** Upstream response id when present (not reconstructed). */
  upstreamResponseId: string | null;
  finishReason: string | null;
  /** Keys/lengths only from SERV payload — never string values. */
  responseShape: string | null;
  /**
   * On parse failure (or always when text present): redacted key/type/length echo.
   * Never stores reason/VIN/prose values — enough to separate null/empty/wrong-shape.
   */
  sanitizedPlannerEcho: SanitizedPlannerParseEcho | null;
  /**
   * Present on parse-ok rows when retention succeeds (bounded complete action;
   * secrets redacted). Null on parse-fail / retention refuse — never overclaimed.
   */
  retainedAction: RetainedScoutPlanAction | null;
};

function usageFromProof(proof: unknown): Usage | null {
  if (!proof || typeof proof !== "object") return null;
  const openserv = (proof as { openserv?: { usage?: Usage } }).openserv;
  return normalizeCompareUsage(openserv?.usage ?? null);
}

function openservMeta(proof: unknown): { id: string | null; finishReason: string | null } {
  if (!proof || typeof proof !== "object") return { id: null, finishReason: null };
  const openserv = (proof as { openserv?: { id?: unknown; finish_reason?: unknown } }).openserv;
  if (!openserv || typeof openserv !== "object") return { id: null, finishReason: null };
  return {
    id: typeof openserv.id === "string" && openserv.id.trim() ? openserv.id.trim() : null,
    finishReason:
      typeof openserv.finish_reason === "string" && openserv.finish_reason.trim()
        ? openserv.finish_reason.trim()
        : null,
  };
}

function summarizeSequential(seq: SequentialTwoDecisionResult) {
  return {
    schemaVersion: seq.schemaVersion,
    mode: seq.mode,
    maxHttpAttemptsTotal: seq.maxHttpAttemptsTotal,
    httpAttemptsTotal: seq.httpAttemptsTotal,
    transportPolicy: seq.transportPolicy,
    timeoutMsPerAttempt: seq.timeoutMsPerAttempt,
    outputTokenBound: seq.outputTokenBound,
    decision1PinsUnchanged: seq.decision1PinsUnchanged,
    stoppedBeforeDecision2: seq.stoppedBeforeDecision2,
    sequentialOrchestrationExecuted: seq.sequentialOrchestrationExecuted,
    disclaimers: seq.disclaimers,
    decisions: seq.decisions,
    apply: seq.apply
      ? {
          stopReason: seq.apply.stopReason,
          continueToDecision2: seq.apply.continueToDecision2,
          dispositionOk: seq.apply.dispositionOk,
          dispositionCode: seq.apply.dispositionCode,
          actionFingerprint: seq.apply.actionFingerprint,
          note: seq.apply.note,
          appliedLocallyOnly: seq.apply.appliedLocallyOnly,
          pendingCountAfter: seq.apply.state.pendingVins.length,
          rejectedCountAfter: seq.apply.state.rejected.length,
          lastOutcomeOk: seq.apply.outcome?.ok ?? null,
          lastOutcomeToolId: seq.apply.outcome?.toolId ?? null,
        }
      : null,
    offlineReplay: seq.offlineReplay
      ? {
          stateKind: seq.offlineReplay.stateKind,
          provenanceNote: seq.offlineReplay.provenanceNote,
          stepId: seq.offlineReplay.stepId,
          inputDiff: seq.offlineReplay.inputDiff,
          pendingCount: seq.offlineReplay.plannerInput.pendingVins.length,
          rejectedCount: seq.offlineReplay.plannerInput.rejected.length,
          recentOutcomesCount: seq.offlineReplay.plannerInput.recentOutcomes.length,
          priorIdenticalStreak: seq.offlineReplay.priorIdenticalStreak,
        }
      : null,
  };
}

function markdownReport(report: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("# SERV scout model compare (PR63 placeholder ledger)");
  lines.push("");
  lines.push(`- Mode: \`${String(report.mode)}\``);
  lines.push(`- Dispatch path: \`${String(report.dispatchPath ?? "unknown")}\``);
  lines.push(
    `- HTTP attempts (full invocation): \`${String(report.httpAttemptsTotal ?? "unknown")}\`; cost=unknown`,
  );
  const sourcePin = report.sourcePin as Record<string, unknown> | null | undefined;
  if (sourcePin && typeof sourcePin === "object") {
    lines.push(
      `- Source pin: head=\`${String(sourcePin.head ?? "unknown")}\` tree=\`${String(sourcePin.tree ?? "unknown")}\``,
    );
  } else {
    lines.push("- Source pin: `null` (SCOUT_COMPARE_SOURCE_PIN absent/invalid — not invented)");
  }
  lines.push(`- Harness head (when committed): see git SHA on PR branch`);
  lines.push(`- Ledger: \`${PR63_PLACEHOLDER_LEDGER_PATH}\``);
  lines.push(`- Deployed SHA under test (ledger): \`${String(report.ledgerDeployedSha)}\``);
  lines.push(`- Production default model: \`${String(report.productionDefaultModel)}\` (unchanged: ${String(report.productionDefaultUnchanged)})`);
  lines.push(`- Cost: **unknown** (console $/M is not reconciled run cost; labeled costunknown)`);
  lines.push("");
  lines.push("## Experiment transport bounds (t296)");
  lines.push("");
  const tb = report.transportBounds as
    | {
        policy?: string;
        maxHttpAttemptsPerStep?: number;
        timeoutMsPerAttempt?: number;
        wallMsPerModelNominal?: number;
        outputTokenBound?: number | null;
        silentEmptyRetry?: boolean;
        silentTimeoutRetry?: boolean;
        productionPlannerRetriesUnchanged?: boolean;
        noArbitraryServRunQuota?: boolean;
      }
    | undefined;
  if (tb) {
    lines.push(`- Policy: \`${tb.policy}\` (eval/compare only — production \`runServ\` empty/timeout recovery unchanged)`);
    lines.push(
      `- Max upstream HTTP per requested scout_plan step: **${tb.maxHttpAttemptsPerStep}** (no silent empty/timeout re-POST; every attempt counted)`,
    );
    lines.push(`- Timeout per attempt: \`${tb.timeoutMsPerAttempt}ms\` (nominal wall/model = steps × timeout = \`${tb.wallMsPerModelNominal}ms\`)`);
    lines.push(`- Output token bound: \`${tb.outputTokenBound ?? "invalid"}\` (default ${SERV_OUTPUT_TOKEN_DEFAULT}; fail-closed on garbage)`);
    lines.push(`- Silent empty retry: \`${tb.silentEmptyRetry}\`; silent timeout retry: \`${tb.silentTimeoutRetry}\``);
    lines.push(`- No arbitrary SERV run quota introduced: \`${tb.noArbitraryServRunQuota}\``);
    lines.push(`- Errors / empty / HTTP failures / refusals are **recorded**, not silently repeated`);
  }
  lines.push("");
  lines.push("## Critical disclaimers (t294/t295)");
  lines.push("");
  lines.push("- **Model-only swap is NOT the demonstrated product fix** for the placeholder-price reject deadlock. Code fixes (query floor, cite grounding, filter) are separate; this harness only compares planner behavior on the same offline ledger input.");
  lines.push("- **Budget-conscious ≠ cheapest.** Do not pick the lowest console $/M at the expense of grounded recovery / anti-loop quality.");
  lines.push("- **Console ≠ in-repo catalog.** Console Available-models is broader (e.g. `gpt-6-luna`); unlisted IDs need parent validation + `SCOUT_COMPARE_ALLOW_UNLISTED=1`.");
  lines.push("- **Zero-network default.** Live requires `SERV_API_KEY` + `SCOUT_COMPARE_ALLOW_PAID=1`.");
  lines.push("- **One attempt per step** on the live compare path via `experiment_single_attempt` — not the production planner retry policy.");
  lines.push("");
  lines.push("## Evidence taxonomy (observed vs hypotheses vs unrecorded)");
  lines.push("");
  const tax = report.evidenceTaxonomy as
    | { observed?: string[]; hypotheses?: string[]; unrecorded_historical?: string[] }
    | undefined;
  if (tax) {
    lines.push("### Observed");
    for (const o of tax.observed ?? []) lines.push(`- ${o}`);
    lines.push("");
    lines.push("### Hypotheses (not proven as sole root cause)");
    for (const h of tax.hypotheses ?? []) lines.push(`- ${h}`);
    lines.push("");
    lines.push("### Unrecorded historical details");
    for (const u of tax.unrecorded_historical ?? []) lines.push(`- ${u}`);
  } else {
    lines.push("_See ledger `evidenceTaxonomy`._");
  }
  lines.push("");
  lines.push("## Offline before / after (reproduction)");
  lines.push("");
  const ba = report.offlineBeforeAfter as {
    before?: string;
    afterCodeFix?: string;
    modelCompareRole?: string;
  };
  if (ba) {
    lines.push(`- **Before (de5eb0c live / offline replay):** ${ba.before ?? ""}`);
    lines.push(`- **After code fix (this branch, offline):** ${ba.afterCodeFix ?? ""}`);
    lines.push(`- **Model compare role:** ${ba.modelCompareRole ?? ""}`);
  }
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
  lines.push(
    "Note: `observedOk=false` is the **historical live** denial on de5eb0c; `grounded=true` under current code reflects the cite-grounding fix on the same citation shape — not a claim the live run was grounded.",
  );
  lines.push("");
  lines.push("## Model × step rows");
  lines.push("");
  const rows = report.rows as ModelStepRow[];
  if (!rows.length) {
    lines.push(
      report.dispatchPath === "sequential_two_decision"
        ? "_No normal compare rows (sequential XOR — sequentialTwoDecisionLive only)._"
        : "_No live model rows (dry-run)._",
    );
  } else {
    for (const r of rows) {
      lines.push(
        `- **${r.modelId}** @ \`${r.stepId}\`: schemaValid=${r.schemaValid}; recovery=${r.score.recoveryClass}; grounded=${r.score.grounded}; antiLoopSafe=${r.score.antiLoopSafe}; latencyMs=${r.latencyMs ?? "n/a"}; httpAttempts=${r.httpAttempts ?? "n/a"}; tokens=${r.tokens?.total_tokens ?? "n/a"}; cost=unknown; unlistedOptIn=${r.unlistedOptIn}${r.error ? `; error=${r.error}` : ""}`,
      );
    }
  }
  lines.push("");
  lines.push("## Remaining limits");
  lines.push("");
  for (const lim of (report.remainingLimits as string[]) ?? []) {
    lines.push(`- ${lim}`);
  }
  return lines.join("\n");
}

async function main() {
  const dryForced = process.env.SCOUT_COMPARE_DRY_RUN === "1";
  const allowPaid = process.env.SCOUT_COMPARE_ALLOW_PAID === "1";
  const allowUnlisted = process.env.SCOUT_COMPARE_ALLOW_UNLISTED === "1";
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

  const fairSlate = process.env.SCOUT_COMPARE_FAIR_SLATE === "1";
  const modelRes = resolveServCompareModelIds(process.env.SERV_COMPARE_MODELS, {
    allowUnlisted,
    fairSlate,
  });
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
  const sequentialOptIn = process.env.SCOUT_COMPARE_SEQUENTIAL === "1";
  const sourcePin = resolveCompareSourcePin(process.env);
  const dispatch = resolveCompareCliDispatch({ live, sequentialOptIn });

  const outputTokenBound = resolveServOutputTokenBound(process.env);
  const sequentialOutputTokens = outputTokenBound.ok
    ? outputTokenBound.tokens
    : SERV_OUTPUT_TOKEN_DEFAULT;

  // Experimental sequential TWO-decision offline fixture (always zero HTTP).
  const sequentialOffline: SequentialTwoDecisionResult = runOfflineSequentialTwoDecision({
    ledger,
    decision1Action: offlineFixtureGroundedReject(ledger.firstVin),
    decision1SchemaValid: true,
    decision2Action: {
      type: "abstain",
      reason: "offline fixture Decision-2 after local reject — NOT a live model response",
      servStepId: "exec:step-2",
    },
    decision2SchemaValid: true,
    timeoutMsPerAttempt: scoutProfile.timeoutMs,
    outputTokenBound: sequentialOutputTokens,
  });
  console.log(
    `Sequential offline fixture: http=${sequentialOffline.httpAttemptsTotal} d1=${sequentialOffline.decisions[0]?.stopReason} d2state=${sequentialOffline.decisions[1]?.stateKind ?? "stopped"} orchestration=${sequentialOffline.sequentialOrchestrationExecuted} (NOT live tools / full-cycle)`,
  );

  /**
   * XOR paid dispatch (fix for 66b151e 5-HTTP breach):
   * - sequential_two_decision → ONLY sequential probe (≤2 HTTP total; no normal rows)
   * - normal_compare → ONLY model×steps loop
   * - dry_run → neither
   */
  console.log(
    `CLI dispatch: path=${dispatch.path} normal=${dispatch.runNormalCompare} sequentialLive=${dispatch.runSequentialLive} maxHttpTotal=${dispatch.maxHttpAttemptsTotal ?? "n/a"} sourcePin=${sourcePin ? "present" : "null"}`,
  );

  const paidPath = await executeCompareCliPaidPath({
    dispatch,
    runNormalCompare: async () => {
      console.log(servCompareCatalogNote());
      console.log(
        `Live normal compare: ${modelRes.models.length} model(s) × ${preparedSteps.length} step(s). Cost unknown until central reconciliation. Model-only swap is NOT the demonstrated product fix.`,
      );
      let httpAttemptsSum = 0;
      for (const model of modelRes.models) {
        for (const prepared of preparedSteps) {
          const user = buildScoutPlanUserMessage(prepared.plannerInput);
          const started = Date.now();
          let latencyMs: number | null = null;
          let tokens: Usage | null = null;
          let rawStatus: number | null = null;
          let reportedModel: string | null = null;
          let error: string | null = null;
          let httpAttempts: number | null = null;
          let upstreamResponseId: string | null = null;
          let finishReason: string | null = null;
          let responseShape: string | null = null;
          let sanitizedPlannerEcho: SanitizedPlannerParseEcho | null = null;
          let schemaValid = false;
          let score: ActionScore;
          let retainedAction: RetainedScoutPlanAction | null = null;

          try {
            // Isolated experiment transport: one upstream attempt per step; empty/timeout
            // are recorded (not silently re-POSTed). Production runServ recovery unchanged.
            const result = await runServ(
              "scout_plan",
              { user },
              experimentServDeps({
                apiKey: key,
                baseUrl: process.env.SERV_BASE_URL,
                model: model.id,
                timeoutMs: scoutProfile.timeoutMs,
              }),
            );
            latencyMs = Date.now() - started;
            tokens = usageFromProof(result.proof);
            reportedModel = result.proof.modelReported || null;
            httpAttempts = result.httpAttempts;
            httpAttemptsSum += Math.max(0, result.httpAttempts);
            responseShape = result.responseShape;
            const meta = openservMeta(result.proof);
            upstreamResponseId = meta.id;
            finishReason = meta.finishReason;

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
                priorIdenticalStreak: prepared.priorIdenticalStreak,
              });
            } else {
              rawStatus = result.rawStatus;
              sanitizedPlannerEcho = sanitizePlannerParseEcho(result.text);
              const parsed = parseScoutPlanText(result.text);
              schemaValid = parsed.ok;
              score = scoreScoutPlanAction({
                action: parsed.ok ? parsed.action : null,
                schemaValid: parsed.ok,
                parseKind: parsed.ok ? null : parsed.kind,
                candidatesByVin: prepared.candidatesByVin,
                recentOutcomes: prepared.plannerInput.recentOutcomes,
                priorDeniedRejectFingerprint: prepared.priorDeniedRejectFingerprint,
                priorIdenticalStreak: prepared.priorIdenticalStreak,
              });
              if (parsed.ok) {
                retainedAction = retainScoutPlanAction(parsed.action);
              } else {
                error = `${parsed.kind}: ${parsed.message}`;
              }
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
              priorIdenticalStreak: prepared.priorIdenticalStreak,
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
            unlistedOptIn: model.unlistedOptIn,
            httpAttempts,
            transportPolicy: "experiment_single_attempt",
            upstreamResponseId,
            finishReason,
            responseShape,
            sanitizedPlannerEcho,
            retainedAction,
          });
          console.log(
            `${model.id} @ ${prepared.stepId}: schemaValid=${schemaValid} recovery=${score.recoveryClass} latencyMs=${latencyMs} httpAttempts=${httpAttempts} cost=unknown`,
          );
        }
      }
      return { httpAttempts: httpAttemptsSum };
    },
    runSequentialLive: async () => {
      const probeModel = modelRes.models[0];
      if (!probeModel) {
        throw new Error(
          "SCOUT_COMPARE_SEQUENTIAL=1 but no resolved models — refusing live probe.",
        );
      }
      console.log(servCompareCatalogNote());
      console.log(
        `Sequential LIVE probe ONLY (XOR — normal compare skipped): model=${probeModel.id} maxHttpTotal=2 timeoutMs=${scoutProfile.timeoutMs} tokens=${sequentialOutputTokens}`,
      );
      const sequentialLive = await runSequentialCompareProbe({
        ledger,
        model: probeModel.id,
        apiKey: key,
        baseUrl: process.env.SERV_BASE_URL,
        timeoutMsPerAttempt: scoutProfile.timeoutMs,
        outputTokenBound: sequentialOutputTokens,
      });
      console.log(
        `Sequential LIVE done: http=${sequentialLive.httpAttemptsTotal}/${sequentialLive.maxHttpAttemptsTotal} d1=${sequentialLive.decisions[0]?.stopReason} d2=${sequentialLive.decisions[1]?.stateKind ?? "stopped"} stoppedBeforeD2=${sequentialLive.stoppedBeforeDecision2}`,
      );
      return sequentialLive;
    },
  });

  const sequentialLive = paidPath.sequentialLive;
  if (dispatch.path === "dry_run") {
    console.log("Dry-run: no SERV/Auto.dev calls. Historical ledger scores + catalog only.");
    console.log(servCompareCatalogNote());
    if (sequentialOptIn) {
      console.log(
        "SCOUT_COMPARE_SEQUENTIAL=1 set but live gates not open (need SERV_API_KEY + SCOUT_COMPARE_ALLOW_PAID=1); offline fixture only — no report-only fake live.",
      );
    }
  }
  console.log(
    `CLI paid path complete: dispatch=${dispatch.path} httpAttemptsTotal=${paidPath.httpAttemptsTotal} normalHttp=${paidPath.normalHttpAttempts} sequentialHttp=${paidPath.sequentialHttpAttempts} cost=unknown`,
  );

  const offlineBeforeAfter = {
    before:
      "On de5eb0c, missing_asking_price@price reject was deny→deny→identical fingerprint no-progress stop; pool was 20 placeholder asks under price=1-20000 + sort=price.",
    afterCodeFix:
      "Offline regression: same citation grounds; query floor 500-N; placeholders filtered under priced search; abstain/search recovery paths score cleanly. See placeholder-price-recovery.regression.test.ts.",
    modelCompareRole:
      "Optional parent sequential SERV compares on SAME offline ledger inputs — not proof that changing BASE_MODEL alone fixes production.",
  };

  const remainingLimits = [
    "Not live-tested by Cursor; parent is sole live coordinator.",
    "Cost remains unknown until central reconciliation (console $/M ≠ receipt).",
    "Unlisted console IDs are not availability/schema guarantees even with ALLOW_UNLISTED.",
    "Full raw step-3 planner payloads were unrecorded in the sanitized handoff.",
    "Whether Auto.dev returns usable asks after 500-N on a given minute is unproven here.",
    "Experiment transport disables silent empty/timeout re-POSTs only; production planner recovery retries stay as designed.",
    "Parse failures now record sanitizedPlannerEcho (keys/types/lengths only) + upstreamResponseId/finishReason/responseShape when present — never raw planner JSON.",
    "All-zero usage on a HTTP 200 refusal is unknown cost — not free. Parent Mini/Luna counts are not efficacy winners.",
    "Structured extraction fix is offline-proven; live 2/3→reliability must be re-measured by parent (repeated cycles, all attempts, latency, costunknown) — no unmeasured 100% claim.",
    "GPT-5.4 cold first-step timeout (45007ms=scout_plan.timeoutMs) is a separate observed class; do not blind-raise timeout — one-variable parent probe if it persists after this head.",
    "66b151e launch breached ≤2: normal 3 rows + sequential 2 = 5 HTTP. XOR dispatch now skips normal compare when SCOUT_COMPARE_SEQUENTIAL=1. No paid-readiness claim; launcher HOLD preserved.",
  ];

  const transportBounds = {
    policy: "experiment_single_attempt" as const,
    /** scout_plan has no applicationTool → one upstream HTTP per requested step. */
    maxHttpAttemptsPerStep: 1,
    timeoutMsPerAttempt: scoutProfile.timeoutMs,
    wallMsPerModelNominal: scoutProfile.timeoutMs * preparedSteps.length,
    outputTokenBound: outputTokenBound.ok ? outputTokenBound.tokens : null,
    outputTokenBoundSource: outputTokenBound.ok ? outputTokenBound.source : "invalid",
    outputTokenDefault: SERV_OUTPUT_TOKEN_DEFAULT,
    cost: "unknown" as const,
    silentEmptyRetry: false,
    silentTimeoutRetry: false,
    productionPlannerRetriesUnchanged: true,
    noArbitraryServRunQuota: true,
    /** Sequential TWO-decision probe: ≤2 HTTP total across decisions (parent-controlled). */
    sequentialTwoDecisionMaxHttpTotal: 2,
    sequentialTwoDecisionDefaultHttp: 0,
  };

  const reportMode =
    dispatch.path === "sequential_two_decision"
      ? "live_sequential_two_decision"
      : dispatch.path === "normal_compare"
        ? "live_compare"
        : "dry_run";

  const report = {
    schemaVersion: "serv-scout-model-compare/v5",
    mode: reportMode,
    /** Exclusive paid path — normal_compare XOR sequential_two_decision XOR dry_run. */
    dispatchPath: dispatch.path,
    /** Total upstream HTTP across the full CLI invocation (not subsection-only). */
    httpAttemptsTotal: paidPath.httpAttemptsTotal,
    normalHttpAttempts: paidPath.normalHttpAttempts,
    sequentialHttpAttempts: paidPath.sequentialHttpAttempts,
    /**
     * Parent-supplied attestation via SCOUT_COMPARE_SOURCE_PIN JSON.
     * null when absent/invalid — never invented from ambient git.
     */
    sourcePin,
    harness: "eval/serv-scout-model-compare.ts",
    ledgerPath: PR63_PLACEHOLDER_LEDGER_PATH,
    ledgerLabel: ledger.label,
    ledgerDeployedSha: ledger.deployedSha,
    ledgerRunId: ledger.runId,
    productionDefaultModel: BASE_MODEL,
    productionDefaultUnchanged: true,
    modelOnlySwapIsNotDemonstratedFix: true,
    budgetConsciousIsNotCheapest: true,
    zeroNetworkDefault: true,
    allowUnlistedOptIn: allowUnlisted,
    strictJsonSchema: Boolean(scoutProfile.jsonSchema),
    transportBounds,
    catalog: listServCompareModels(),
    modelsSelected: modelRes.models,
    evidenceTaxonomy: ledger.evidenceTaxonomy ?? null,
    offlineBeforeAfter,
    remainingLimits,
    stepUserMessages,
    historicalScores,
    rows,
    /** Offline sequential TWO-decision fixture (zero HTTP). Decision-2 = offline_replay ≠ live tools. */
    sequentialTwoDecisionOffline: summarizeSequential(sequentialOffline),
    /**
     * Live sequential probe when dispatchPath=sequential_two_decision.
     * Null when opt-in unset, live gates closed, or XOR selected normal_compare.
     */
    sequentialTwoDecisionLive: sequentialLive ? summarizeSequential(sequentialLive) : null,
    sequentialLiveOptIn: sequentialOptIn,
    sequentialLiveExecuted: Boolean(sequentialLive?.sequentialOrchestrationExecuted),
    cost: "unknown" as const,
    notes: [
      ...ledger.notes,
      "Parent sole live coordinator — Cursor worker must not set SCOUT_COMPARE_ALLOW_PAID.",
      "Repeated-action / evidence guards are scored, not weakened.",
      "Model-only swap is NOT the demonstrated product fix.",
      "Budget-conscious ≠ cheapest-at-expense-of-quality.",
      "Console Available-models broader than in-repo catalog; ALLOW_UNLISTED is parent opt-in only.",
      "Not a claim that any model beats another until parent runs live rows.",
      "Live path uses experiment_single_attempt: one HTTP per step; empty/timeout/HTTP errors/refusals recorded, not silently repeated.",
      "Production runServ empty/timeout recovery is unchanged outside this harness.",
      "Schema mismatch rows include sanitized field presence (reason/servStepId/type) without storing raw response text.",
      "json_schema profiles extract content/parsed/refusal only — tool_call args and reasoning drafts are not planner text (enables production empty-text recovery). Offline synthetic draft-as-JSON hazard — not proven live Luna RCA (raw body unretained).",
      "Experimental sequential TWO-decision XOR: SCOUT_COMPARE_SEQUENTIAL=1 + paid gates runs ONLY D1→local apply→D2 (≤2 HTTP across full CLI invocation; normal model×steps compare is skipped). Ungrounded/denied stops before D2; already-processed VIN fails closed. NOT live tool-result / full-cycle. Raw 83929cd action unretained.",
      "Sequential decision rows include rawStatus/latencyMs/tokens/upstreamResponseId/finishReason/responseShape when known; cost always unknown. sourcePin echoes SCOUT_COMPARE_SOURCE_PIN or null.",
      "Parse-ok compare rows include retainedAction when retention succeeds (bounded complete structured decision, secrets redacted); null otherwise. sanitizePlannerParseEcho never embeds string values.",
      "STOP: no paid-readiness claim from this harness alone — independent review + spend reconciliation required after any live launch.",
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
