/**
 * Offline Reppo experiment over an existing eval:serv result.
 *
 * Usage: REPPO_API_KEY=... npm run eval:reppo
 * Reads eval/results/latest.json (or AUTOFLIP_EVAL_FILE), submits up to five
 * report_explain cases in both baseline and SERV variants, and writes a receipt.
 * It never runs on customer reports and never changes application behaviour.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { EVAL_CASES } from "../src/domain/eval-cases";
import { getReppoEvaluation, submitReppoEvaluation } from "../src/server/reppo/client";

const apiKey = process.env.REPPO_API_KEY?.trim() ?? "";
if (!apiKey) {
  console.error("REPPO_API_KEY is not set. No Reppo request was made.");
  process.exit(1);
}

type EvalRow = {
  caseId: string;
  profile: string;
  title: string;
  task: string;
  synthetic: boolean;
  plain: { text: string };
  serv: { text: string };
};
type EvalArtifact = { rows?: EvalRow[] };
type Receipt = {
  generatedAt: string;
  sourceFile: string;
  requested: number;
  submissions: Array<{
    caseId: string;
    variant: "baseline" | "serv";
    evalId: string | null;
    response: unknown;
    error?: string;
  }>;
};

function withoutIdentifiers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIdentifiers);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/vin|vehicle.?id|listing.?id/i.test(key)) continue;
    output[key] = withoutIdentifiers(child);
  }
  return output;
}

function redactVin(text: string): string {
  return text.replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, "[VIN redacted]");
}

function extractEvalId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return typeof row.evalId === "string" ? row.evalId : null;
}

async function main() {
  const sourceFile = process.env.AUTOFLIP_EVAL_FILE || path.join(process.cwd(), "eval", "results", "latest.json");
  if (!existsSync(sourceFile)) {
    throw new Error(`Evaluation artifact not found: ${sourceFile}. Run npm run eval:serv first or set AUTOFLIP_EVAL_FILE.`);
  }
  const artifact = JSON.parse(readFileSync(sourceFile, "utf8")) as EvalArtifact;
  const rows = (artifact.rows ?? []).filter((row) => row.profile === "report_explain");
  const cases = new Map(EVAL_CASES.map((item) => [item.id, item]));
  const selected = rows.filter((row) => row.plain?.text?.trim() || row.serv?.text?.trim()).slice(0, 5);
  if (!selected.length) throw new Error("No report_explain rows with output were found in the evaluation artifact.");

  const receipt: Receipt = {
    generatedAt: new Date().toISOString(),
    sourceFile,
    requested: selected.length * 2,
    submissions: [],
  };
  const outputDir = path.join(process.cwd(), "eval", "results");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "reppo-latest.json");
  const persist = () => writeFileSync(outputPath, JSON.stringify(receipt, null, 2));

  for (const row of selected) {
    const testCase = cases.get(row.caseId);
    if (!testCase) continue;
    for (const variant of ["baseline", "serv"] as const) {
      const explanation = row[variant].text?.trim();
      if (!explanation) continue;
      const payload = [
        `AutoFlip report explanation — ${variant === "baseline" ? "plain-model baseline" : "SERV-assisted"}`,
        `Case: ${row.caseId}`,
        redactVin(explanation),
      ].join("\n\n");
      const context = [
        `Task: ${row.task}`,
        `Case label: ${row.title}`,
        `Fixture type: ${testCase.synthetic ? "synthetic adversarial fixture" : "fixed evaluation fixture"}`,
        "Ground truth supplied by AutoFlip's deterministic test fixture (vehicle identifiers removed):",
        JSON.stringify(withoutIdentifiers(testCase.facts)),
        "Evaluate only whether the explanation faithfully represents these supplied facts, distinguishes estimates from verified facts, communicates material uncertainty, and explains the task without contradicting the supplied deterministic result.",
        "Do not independently estimate vehicle market value or claim that the supplied facts are externally verified. If relevant evidence is unavailable to support an evidence-grounded verdict, return the provider's insufficient-evidence outcome rather than guessing.",
      ].join("\n\n");

      try {
        const response = await submitReppoEvaluation({
          apiKey,
          type: "trace",
          payload,
          context,
          settlementMinutes: 10,
        });
        receipt.submissions.push({
          caseId: row.caseId,
          variant,
          evalId: extractEvalId(response),
          response,
        });
      } catch (error) {
        receipt.submissions.push({
          caseId: row.caseId,
          variant,
          evalId: null,
          response: null,
          error: error instanceof Error ? error.message : "Unknown Reppo API error",
        });
      }
      persist();
      console.log(`${receipt.submissions.length}/${receipt.requested} ${row.caseId} ${variant}`);
    }
  }
  console.log(`Saved Reppo submission receipts to ${outputPath}`);
  console.log("Wait for the selected settlement window, then inspect each returned evalId with the Reppo console/API.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The Reppo experiment stopped.");
  process.exit(1);
});
