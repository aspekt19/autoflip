/**
 * Offline preflight for fair SERV model compare (t317).
 *
 * Zero network. Prints Flip-ready commands, exact docs model IDs, protocol
 * issues (integration vs model), and runs dry-run harness validation.
 *
 *   npm run eval:serv-compare-preflight
 *
 * Flip live (parent only — this script never sets paid gates):
 *   See printed commands. Requires SERV_API_KEY + SCOUT_COMPARE_ALLOW_PAID=1.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  SERV_COMPARE_FAIR_SLATE,
  listServFairSlateModels,
  resolveServCompareModelIds,
  servCompareCatalogNote,
  servCompareProtocolIssues,
  BASE_MODEL,
} from "../src/server/serv";
import { resolveCompareCliDispatch } from "../src/server/scout/compare-cli-dispatch";
import { loadPlaceholderLedger, scoreHistoricalLedgerActions } from "../src/domain/scout/serv-model-compare";

function main(): number {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push("# SERV fair compare preflight (offline — zero network)");
  push("");
  push(`Generated: ${new Date().toISOString()}`);
  push(`Production BASE_MODEL (unchanged): \`${BASE_MODEL}\``);
  push("");

  push("## Exact fair-slate model IDs (docs.openserv.ai)");
  push("");
  for (const m of SERV_COMPARE_FAIR_SLATE) {
    push(`- **${m.id}** — provider=\`${m.provider}\` role=\`${m.role}\` endpoint=\`${m.requiredEndpoint}\``);
    for (const n of m.protocolNotes) push(`  - ${n}`);
  }
  push("");
  push("Alternates Flip may substitute after console check: `claude-sonnet-5`, `claude-sonnet-5.5`, `gemini-3.5-flash`.");
  push("");

  const resolved = resolveServCompareModelIds("", { fairSlate: true });
  if (!resolved.ok) {
    console.error(resolved.message);
    return 1;
  }
  push("## Resolved fair slate (scout_plan effective IDs)");
  push("");
  for (const m of resolved.models) {
    push(`- request \`${m.id}\` → effective \`${m.effectiveForScoutPlan}\` (${m.kind})`);
  }
  push("");

  push("## Protocol issues (integration vs model fault)");
  push("");
  for (const issue of servCompareProtocolIssues()) {
    push(`### ${issue.id} — \`${issue.class}\``);
    push(issue.summary);
    push(`Evidence: ${issue.evidence}`);
    push("");
  }

  push("## XOR dispatch bounds (no live)");
  push("");
  const dry = resolveCompareCliDispatch({ live: false, sequentialOptIn: false });
  const seq = resolveCompareCliDispatch({ live: true, sequentialOptIn: true });
  const normal = resolveCompareCliDispatch({ live: true, sequentialOptIn: false });
  push(`- dry_run: path=${dry.path} maxHttp=${dry.maxHttpAttemptsTotal}`);
  push(`- live+sequential: path=${seq.path} maxHttp=${seq.maxHttpAttemptsTotal} (XOR — normal skipped)`);
  push(`- live normal: path=${normal.path} maxHttp=${String(normal.maxHttpAttemptsTotal)}`);
  push("");

  push("## Saved evidence (SAME scenarios)");
  push("");
  const ledger = loadPlaceholderLedger();
  const hist = scoreHistoricalLedgerActions(ledger);
  push(`- Ledger: \`${ledger.label}\` runId=${ledger.runId} deployedSha=${ledger.deployedSha}`);
  push(`- Historical labeled actions scored offline: ${hist.length}`);
  for (const h of hist.slice(0, 4)) {
    push(
      `  - ${h.stepId}: recovery=${h.score.recoveryClass} grounded=${h.score.grounded} antiLoopSafe=${h.score.antiLoopSafe} (observedOk=${h.observedOutcomeOk})`,
    );
  }
  push("");

  push("## Catalog note");
  push("```");
  push(servCompareCatalogNote());
  push("```");
  push("");

  push("## Flip ready-run commands (parent only — spends SERV)");
  push("");
  push("### 0) Offline dry-run (safe; this agent already runs this class)");
  push("```bash");
  push("npm run eval:scout-model-compare");
  push("SCOUT_COMPARE_FAIR_SLATE=1 npm run eval:scout-model-compare");
  push("npm run eval:serv-compare-preflight");
  push("```");
  push("");
  push("### 1) Fair three-model SAME-ledger compare (normal path; records refusals/timeouts/latency/tokens; cost=unknown)");
  push("```bash");
  push("SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_FAIR_SLATE=1 \\");
  push(
    `  SERV_COMPARE_MODELS=${listServFairSlateModels()
      .map((m) => m.id)
      .join(",")} \\`,
  );
  push("  npm run eval:scout-model-compare");
  push("```");
  push("");
  push("### 2) Sequential TWO-decision XOR probe (≤2 HTTP total; Mini or one peer — not stacked on normal)");
  push("```bash");
  push("SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_SEQUENTIAL=1 \\");
  push("  SERV_COMPARE_MODELS=gpt-5.4-mini \\");
  push("  SCOUT_COMPARE_SOURCE_PIN='{\"head\":\"<PR77_HEAD>\",\"tree\":\"<PR77_TREE>\",\"base\":\"cursor/find-nav-provenance-ecfd-1033\"}' \\");
  push("  npm run eval:scout-model-compare");
  push("```");
  push("");
  push("### Scoring contract (genuine — not catalogs-as-results)");
  push("- Per step: schemaValid, grounded, recoveryClass, antiLoopSafe, claimsVehicleDefectFromPlaceholder");
  push("- Transport: rawStatus, latencyMs, tokens, finishReason, upstreamResponseId, error (timeouts/refusals/empty recorded)");
  push("- cost always `unknown` until central billing reconciliation");
  push("- Model-only swap is NOT the demonstrated PR63 product fix");
  push("");
  push("## Not run by this preflight");
  push("- No SERV_API_KEY read for live calls");
  push("- No provider / Auto.dev / browser");
  push("- No PR71 merge; XOR/sequential ported selectively onto PR77");
  push("");

  const outDir = resolve("eval/results");
  mkdirSync(outDir, { recursive: true });
  const mdPath = resolve(outDir, "serv-compare-preflight.md");
  writeFileSync(mdPath, lines.join("\n"));
  console.log(lines.join("\n"));
  console.log(`\nWrote ${mdPath}`);

  // Dry-run harness validation (still zero network).
  const dryRun = spawnSync("npm", ["run", "eval:scout-model-compare"], {
    cwd: resolve("."),
    env: { ...process.env, SCOUT_COMPARE_DRY_RUN: "1", SCOUT_COMPARE_FAIR_SLATE: "1" },
    encoding: "utf8",
  });
  if (dryRun.status !== 0) {
    console.error("Dry-run eval:scout-model-compare failed:");
    console.error(dryRun.stdout);
    console.error(dryRun.stderr);
    return dryRun.status ?? 1;
  }
  console.log("Dry-run eval:scout-model-compare: OK (fair slate env set; zero network).");
  return 0;
}

process.exit(main());
