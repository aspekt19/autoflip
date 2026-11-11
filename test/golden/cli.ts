/**
 * Golden-query runner.
 *   npm run golden                 replay (default, offline)
 *   npm run golden -- --mode record
 *   GOLDEN_BASE_URL=… GOLDEN_COOKIE=… npm run golden -- --mode live
 *
 * Replay does not invent responses. Record writes real upstream bodies only.
 */
import { GOLDEN_CASES, caseById, type GoldenCaseId } from "./cases";
import { dispositionFor, KNOWN_FAILURES, type GateDisposition } from "./known-failures";
import { assertInvariants } from "./invariants";
import { renderBuyerHtml } from "./render";
import { runGoldenCase } from "./run-case";
import { runLiveCases } from "./live";
import type { GoldenMode } from "./transport";

const SERV_CAP = 60;

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function modeFromArgs(): GoldenMode {
  const raw = argValue("--mode") ?? process.env.GOLDEN_MODE ?? "replay";
  if (raw === "replay" || raw === "record" || raw === "live") return raw;
  console.error(`Unknown mode “${raw}”. Use replay, record, or live.`);
  process.exit(2);
}

function keySet(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

async function main() {
  const mode = modeFromArgs();
  const only = argValue("--case");
  const cases = only ? [caseById(only)] : [...GOLDEN_CASES];
  const serv = keySet("SERV_API_KEY") || keySet("OPENSERV_API_KEY");
  const autodev = keySet("AUTODEV_API_KEY");

  console.log(`golden mode: ${mode}`);
  console.log(`SERV_API_KEY: ${keySet("SERV_API_KEY") ? "set" : "missing"}`);
  console.log(`OPENSERV_API_KEY: ${keySet("OPENSERV_API_KEY") ? "set" : "missing"}`);
  console.log(`AUTODEV_API_KEY: ${autodev ? "set" : "missing"}`);

  if (mode === "record" && (!serv || !autodev)) {
    console.error(
      "Recording needs a SERV key (SERV_API_KEY or OPENSERV_API_KEY) and AUTODEV_API_KEY. Recording runs later. No recording files were written.",
    );
    process.exit(2);
  }
  if (mode === "live") {
    const base = process.env.GOLDEN_BASE_URL?.trim() ?? "";
    const cookie = process.env.GOLDEN_COOKIE?.trim() ?? "";
    if (!base || !cookie) {
      console.error("Live mode needs GOLDEN_BASE_URL and GOLDEN_COOKIE (signed-in test user). Nothing was called.");
      process.exit(2);
    }
    const code = await runLiveCases(cases, base, cookie);
    process.exit(code);
  }

  if (mode === "record") {
    console.log(`Recording live responses on gpt-6.1-sol. OpenServ call cap: ${SERV_CAP} (about $3, owner-approved).`);
  }

  const spend = { maxServCalls: SERV_CAP, count: { n: 0 } };
  const started = Date.now();
  let pending = 0;
  let unexpected = 0;
  const specHashWired = { yes: false };

  for (const specCase of cases) {
    const first = await runGoldenCase(specCase, mode, mode === "record" ? spend : undefined);
    const second = mode === "replay" ? await runGoldenCase(specCase, mode) : undefined;
    if (first.proofRecords.some((row) => typeof row.specHash === "string")) specHashWired.yes = true;
    const html = renderBuyerHtml(first);
    const failures = assertInvariants({
      run: first,
      again: second,
      specCase,
      html,
      mode,
    });
    if (first.recordingsPending) pending += 1;
    const ids = failures.map((row) => row.id);
    const disposition: GateDisposition = dispositionFor(specCase.id as GoldenCaseId, ids);
    if (disposition === "unexpected") unexpected += 1;
    const known = KNOWN_FAILURES[specCase.id as GoldenCaseId];
    console.log(`\n${specCase.id}  ${disposition}${known && disposition === "known_failure" ? `  (${known.summary})` : ""}`);
    if (first.recordingsPending) console.log("  recordings: pending");
    if (disposition === "known_cleared") console.log("  known failure cleared — drop it from test/golden/known-failures.ts when U1/U2 have landed");
    for (const failure of failures) console.log(`  ${failure.id}: ${failure.message}`);
    console.log(
      `  queries=${first.providerQueriesUsed} verdict=${first.verdict ?? "none"} budget=${first.final.budgetUsd ?? "none"} ${first.elapsedMs}ms`,
    );
  }

  const total = Date.now() - started;
  console.log(`\n${cases.length} cases in ${total} ms. OpenServ calls this process: ${spend.count.n}.`);
  if (!specHashWired.yes) {
    console.log("I4: proof records do not carry specHash yet (SearchSpec lineage lands with U1/U5). Mismatches fail once the field is present.");
  }
  if (pending === cases.length && mode === "replay") {
    console.log("Recordings are pending. Replay did not fabricate responses. Record later with SERV + AUTODEV keys.");
  } else if (pending === 0 && mode === "replay") {
    console.log("Recordings are on disk and were replayed.");
  }
  if (mode === "replay" && total >= 60_000) {
    console.error(`Replay exceeded 60s (${total} ms).`);
    process.exit(1);
  }
  if (unexpected > 0) {
    console.error(`${unexpected} case(s) failed outside the known-failure list.`);
    process.exit(1);
  }
  console.log(unexpected === 0 ? "Gate: no unexpected failures." : "Gate: failed.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Golden runner failed.";
  console.error(message);
  process.exit(1);
});
