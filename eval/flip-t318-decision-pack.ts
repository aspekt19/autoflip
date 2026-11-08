/**
 * Freeze Flip t318 end-to-end decision/tool replay pack (offline — zero network).
 *
 * Writes artifacts/flip-t318-decision-pack/ with SAME-input pins, shortlist,
 * scoring criteria, failure/refusal sanitization notes, and parent commands.
 *
 *   npm run eval:flip-t318-decision-pack
 *
 * This script never reads SERV_API_KEY for live calls.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadPlaceholderLedger,
  prepareCompareStep,
  offlineFixtureGroundedReject,
  scoreScoutPlanAction,
  scoreFlipCycleProgress,
  PR63_PLACEHOLDER_LEDGER_PATH,
  runOfflineSequentialTwoDecision,
} from "../src/domain/scout/serv-model-compare";
import { buildScoutPlanUserMessage } from "../src/server/scout/plan-user-message";
import { profile, BASE_MODEL } from "../src/server/serv/profiles";
import {
  SERV_FLIP_DECISION_SHORTLIST,
  SERV_FLIP_DECISION_SHORTLIST_IDS,
  flipDecisionShortlistNote,
} from "../src/server/serv/flip-decision-shortlist";
import {
  listServFlipDecisionShortlist,
  resolveServCompareModelIds,
  servCompareProtocolIssues,
} from "../src/server/serv/model-catalog";
import { resolveCompareCliDispatch } from "../src/server/scout/compare-cli-dispatch";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function main(): number {
  const outDir = resolve("artifacts/flip-t318-decision-pack");
  mkdirSync(outDir, { recursive: true });

  const ledger = loadPlaceholderLedger();
  const d1Def =
    ledger.compareSteps.find((s) => s.id === "after_inventory_before_reject") ??
    ledger.compareSteps[0]!;
  const d1 = prepareCompareStep(ledger, d1Def);
  const d1User = buildScoutPlanUserMessage(d1.plannerInput);
  const system = profile("scout_plan").system;

  const offlineSeq = runOfflineSequentialTwoDecision({
    ledger,
    decision1Action: offlineFixtureGroundedReject(ledger.firstVin),
    decision1SchemaValid: true,
  });

  const canRevise = d1.plannerInput.evidenceContext.searchContinuation.canReviseSearch;
  const d1Score = scoreScoutPlanAction({
    action: offlineFixtureGroundedReject(ledger.firstVin),
    schemaValid: true,
    candidatesByVin: d1.candidatesByVin,
    recentOutcomes: d1.plannerInput.recentOutcomes,
    priorDeniedRejectFingerprint: d1.priorDeniedRejectFingerprint,
    priorIdenticalStreak: d1.priorIdenticalStreak,
    canReviseSearch: canRevise,
  });

  // Sonnet-parent class: D1 grounded reject + D2 abstain while budget remains → fail cycle.
  const prematureD2 = scoreScoutPlanAction({
    action: {
      type: "abstain",
      reason: "No replacement search available after reject",
      servStepId: "exec:2",
    },
    schemaValid: true,
    candidatesByVin: d1.candidatesByVin,
    recentOutcomes: d1.plannerInput.recentOutcomes,
    priorDeniedRejectFingerprint: d1.priorDeniedRejectFingerprint,
    canReviseSearch: canRevise,
  });
  const badCycle = scoreFlipCycleProgress({
    decision1: d1Score,
    decision2: prematureD2,
    canReviseSearch: canRevise,
  });

  const suggestion = d1.plannerInput.evidenceContext.searchContinuation.suggestions[0];
  const goodD2 = suggestion
    ? scoreScoutPlanAction({
        action: {
          type: "run_tool",
          toolId: "inventory.search",
          vin: null,
          reason: suggestion.why,
          servStepId: "exec:2",
          args: suggestion.args,
        },
        schemaValid: true,
        candidatesByVin: d1.candidatesByVin,
        recentOutcomes: d1.plannerInput.recentOutcomes,
        priorDeniedRejectFingerprint: d1.priorDeniedRejectFingerprint,
        canReviseSearch: true,
      })
    : null;
  const goodCycle = scoreFlipCycleProgress({
    decision1: d1Score,
    decision2: goodD2,
    canReviseSearch: canRevise,
  });

  const resolved = resolveServCompareModelIds(SERV_FLIP_DECISION_SHORTLIST_IDS.join(","));
  if (!resolved.ok) {
    console.error(resolved.message);
    return 1;
  }

  const seqDispatch = resolveCompareCliDispatch({ live: true, sequentialOptIn: true });

  const shortlist = {
    sourceCsv: "uploads/all-models-20261108_c8cc.csv (agent workspace capture)",
    sourceReadme: "uploads/all-models-20261108-readme_80ae.txt",
    capturedNote:
      "OpenServ console Available models; 31 rows; Nov 8 2026. Display prices ≠ capability.",
    entries: SERV_FLIP_DECISION_SHORTLIST,
    resolvedEffective: resolved.models.map((m) => ({
      id: m.id,
      effectiveForScoutPlan: m.effectiveForScoutPlan,
      kind: m.kind,
      provider: m.provider,
    })),
  };

  const criteria = {
    productCompatible: true,
    require: [
      "Same ledger input / checks / source pins / call-accounting across shortlist IDs",
      "FAIL / timeout / refusal recorded with usage sanitization (no raw refusal prose)",
      "Current production-compatible scout_plan adapters/profiles (experiment_single_attempt for live compare)",
      "Grounded evidence from PR63 placeholder ledger — not fake catalogs-as-results",
      "No PR71-as-only-proof / no PR71 blanket merge",
      "Gemini content_null_refusal_field diagnostic prerequisite before any blind Gemini retry",
      "Cycle: new search + checks + replan when bad prices; source-faithful; unknown history+cost — not one reject then stop",
    ],
    scoreFlipCycleProgress: {
      badCycleExample: badCycle,
      goodCycleExample: goodCycle,
    },
    transportSanitization: [
      "classifyServPlannerFailure → category/reasonCode/refusalBytes/usage only",
      "normalizeCompareUsageLoose for Gemini camelCase usage aliases",
      "cost always unknown until billing reconcile",
    ],
  };

  const pins = {
    ledgerPath: PR63_PLACEHOLDER_LEDGER_PATH,
    ledgerLabel: ledger.label,
    ledgerRunId: ledger.runId,
    ledgerDeployedSha: ledger.deployedSha,
    decision1StepId: d1.stepId,
    budgets: ledger.budgets,
    usageAtSelectEntry: ledger.usageAtSelectEntry,
    providerCallsRemaining:
      d1.plannerInput.evidenceContext.searchContinuation.providerCallsRemaining,
    canReviseSearch: canRevise,
    midLoopSearchesRemaining:
      d1.plannerInput.evidenceContext.searchContinuation.midLoopSearchesRemaining,
    productionBaseModel: BASE_MODEL,
    scoutPlanTimeoutMs: profile("scout_plan").timeoutMs,
    sequentialMaxHttp: seqDispatch.maxHttpAttemptsTotal,
    sequentialPath: seqDispatch.path,
  };

  const hashes = {
    scoutPlanSystemSha256: sha256(system),
    scoutPlanSystemBytes: Buffer.byteLength(system, "utf8"),
    decision1UserSha256: sha256(d1User),
    decision1UserBytes: Buffer.byteLength(d1User, "utf8"),
  };

  writeFileSync(resolve(outDir, "SHORTLIST.json"), JSON.stringify(shortlist, null, 2) + "\n");
  writeFileSync(resolve(outDir, "CRITERIA.json"), JSON.stringify(criteria, null, 2) + "\n");
  writeFileSync(resolve(outDir, "PINS.json"), JSON.stringify(pins, null, 2) + "\n");
  writeFileSync(resolve(outDir, "HASHES.json"), JSON.stringify(hashes, null, 2) + "\n");
  writeFileSync(resolve(outDir, "decision1.user.json"), d1User + "\n");
  writeFileSync(
    resolve(outDir, "PROTOCOL_ISSUES.json"),
    JSON.stringify(servCompareProtocolIssues(), null, 2) + "\n",
  );
  writeFileSync(
    resolve(outDir, "OFFLINE_SEQUENTIAL_FIXTURE.json"),
    JSON.stringify(
      {
        note: "Offline fixture only — not a live SERV result. Parent runs sequential live.",
        offlineSeqSummary: {
          httpAttemptsTotal: offlineSeq.httpAttemptsTotal,
          maxHttpAttemptsTotal: offlineSeq.maxHttpAttemptsTotal,
          stoppedBeforeDecision2: offlineSeq.stoppedBeforeDecision2,
          decisionCount: offlineSeq.decisions.length,
          decision1SchemaValid: offlineSeq.decisions[0]?.score.schemaValid ?? null,
          decision2SchemaValid: offlineSeq.decisions[1]?.score.schemaValid ?? null,
        },
      },
      null,
      2,
    ) + "\n",
  );

  const idsCsv = SERV_FLIP_DECISION_SHORTLIST_IDS.join(",");
  const commands = `# Flip t318 decision pack — parent commands (spends SERV)

**Pack path:** \`artifacts/flip-t318-decision-pack/\`
**Offline freeze:** \`npm run eval:flip-t318-decision-pack\` (this agent; zero network)

## Shortlist (exact console IDs — order matters)

${SERV_FLIP_DECISION_SHORTLIST.map(
  (e) =>
    `${e.flipOrder}. \`${e.modelId}\` (${e.displayName}) role=${e.flipRole} — in=${e.inputPerMDisplay} out=${e.outputPerMDisplay} (display only)`,
).join("\n")}

Do **not** run all 31 Available models. Names/tier ≠ ability proof.

## 0) Offline dry-run (safe)

\`\`\`bash
npm run eval:flip-t318-decision-pack
SERV_COMPARE_MODELS=${idsCsv} npm run eval:scout-model-compare
\`\`\`

## 1) Sequential TWO-decision XOR per shortlist ID (≤2 HTTP each; Flip sole spend)

Run **one model at a time** in flipOrder. XOR: SCOUT_COMPARE_SEQUENTIAL=1 skips normal compare.
D1 inventory.search matching suggestions is **executed** (recorded immutable receipt) → Decision-2 sees tool evidence.

\`\`\`bash
# Baseline — Claude Sonnet 5.5
SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_SEQUENTIAL=1 \\
  SERV_COMPARE_MODELS=claude-sonnet-5.5 \\
  SCOUT_COMPARE_SOURCE_PIN='{"head":"<IMPLEMENT_TIP>","tree":"<IMPLEMENT_TREE>","pr":78,"pack":"artifacts/flip-t318-decision-pack"}' \\
  npm run eval:scout-model-compare

# Next — GPT-5.6 Sol
SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_SEQUENTIAL=1 \\
  SERV_COMPARE_MODELS=gpt-5.6-sol \\
  SCOUT_COMPARE_SOURCE_PIN='{"head":"<IMPLEMENT_TIP>","tree":"<IMPLEMENT_TREE>","pr":78,"pack":"artifacts/flip-t318-decision-pack"}' \\
  npm run eval:scout-model-compare

# Ablation (no prefilled suggestions) — discriminatory multistep
SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_SEQUENTIAL=1 \\
  SCOUT_COMPARE_HIDE_SUGGESTIONS=1 \\
  SERV_COMPARE_MODELS=claude-sonnet-5.5 \\
  SCOUT_COMPARE_SOURCE_PIN='{"head":"<IMPLEMENT_TIP>","tree":"<IMPLEMENT_TREE>","pr":78,"ablation":"hide_suggestions"}' \\
  npm run eval:scout-model-compare

# Fable only when Flip needs a third discriminatory model (not price-alone)
SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_SEQUENTIAL=1 \\
  SCOUT_COMPARE_HIDE_SUGGESTIONS=1 \\
  SERV_COMPARE_MODELS=claude-fable-5 \\
  SCOUT_COMPARE_SOURCE_PIN='{"head":"<IMPLEMENT_TIP>","tree":"<IMPLEMENT_TREE>","pr":78,"ablation":"hide_suggestions"}' \\
  npm run eval:scout-model-compare
\`\`\`

## Call accounting / failure contract

- Transport: \`experiment_single_attempt\` — record FAIL / timeout / empty / refusal; no silent re-POST
- Usage: \`normalizeCompareUsageLoose\` + failureDiag (category/reasonCode/refusalBytes) — never raw refusal
- cost=\`unknown\` until billing reconcile
- Production \`BASE_MODEL=${BASE_MODEL}\` unchanged; profile override via \`SERV_PROFILE_MODEL_SCOUT_PLAN\` if Flip opts

## Gemini prerequisite (before any blind Gemini retry)

Parent Gemini 3.1 Pro Preview: content-null + ~19-char refusal field. Require \`content_null_refusal_field\` diagnostic + usage repair. Refusal cause **not known** — do not assert format vs safety RCA. No blind Gemini rerun from this pack.

## Product cycle criteria (pass/fail)

- PASS example offline: grounded reject → revised inventory.search → \`progress_grounded_reject_then_revise\`
- FAIL example offline: grounded reject → abstain while canReviseSearch → \`premature_stop_after_single_reject\`
- See \`CRITERIA.json\`

## Not in this pack

- No PR71 blanket merge / PR71-as-only-proof
- No Graph / new services / cosmetics
- No hosted calls from the pack-freeze agent
`;

  writeFileSync(resolve(outDir, "COMMANDS.md"), commands);

  const manifest = {
    packId: "flip-t318-decision-pack",
    generatedAt: new Date().toISOString(),
    network: "zero",
    productionBaseModel: BASE_MODEL,
    shortlistIds: SERV_FLIP_DECISION_SHORTLIST_IDS,
    files: [
      "SHORTLIST.json",
      "CRITERIA.json",
      "PINS.json",
      "HASHES.json",
      "decision1.user.json",
      "PROTOCOL_ISSUES.json",
      "OFFLINE_SEQUENTIAL_FIXTURE.json",
      "COMMANDS.md",
      "MANIFEST.json",
      "README.md",
    ],
    hashes,
    pins,
    catalogNote: flipDecisionShortlistNote(),
    flipResolved: listServFlipDecisionShortlist().map((m) => m.id),
  };
  writeFileSync(resolve(outDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");

  const readme = `# Flip t318 decision / tool replay pack

Frozen offline SAME-input pack for parent Flip sequential SERV on PR #77.

- **Shortlist:** ${SERV_FLIP_DECISION_SHORTLIST_IDS.join(", ")}
- **Ledger:** \`${PR63_PLACEHOLDER_LEDGER_PATH}\`
- **Decision-1 user sha256:** \`${hashes.decision1UserSha256}\`
- **scout_plan system sha256:** \`${hashes.scoutPlanSystemSha256}\`
- **canReviseSearch:** ${canRevise}
- **Cycle FAIL example:** \`${badCycle.code}\` (reject then abstain)
- **Cycle PASS example:** \`${goodCycle.code}\`

See \`COMMANDS.md\` for Flip-only paid sequential runs. This freeze is zero-network.

**PR78 execute path:** D1 \`inventory.search\` matching suggestions applies immutable recorded receipts → Decision-2 (not \`requires_external_tool\` echo-stop). Ablation: \`SCOUT_COMPARE_HIDE_SUGGESTIONS=1\`. Retain Fable for discriminatory multistep only.

Production \`BASE_MODEL\` remains \`${BASE_MODEL}\` until independent review + Flip cycle.
`;
  writeFileSync(resolve(outDir, "README.md"), readme);

  // Sanity: decision1 user is valid JSON
  JSON.parse(d1User);
  // Ledger file still present
  readFileSync(resolve(PR63_PLACEHOLDER_LEDGER_PATH), "utf8");

  console.log(readme);
  console.log(`\nWrote pack → ${outDir}`);
  console.log(flipDecisionShortlistNote());
  return 0;
}

process.exit(main());
