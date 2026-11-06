/**
 * Fetch current Reppo results for IDs saved by eval/reppo.ts.
 * Usage: REPPO_API_KEY=... npm run eval:reppo:status
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getReppoEvaluation } from "../src/server/reppo/client";

const apiKey = process.env.REPPO_API_KEY?.trim() ?? "";
if (!apiKey) {
  console.error("REPPO_API_KEY is not set. No Reppo request was made.");
  process.exit(1);
}

type Submission = {
  caseId: string;
  variant: "baseline" | "serv";
  evalId: string | null;
  response: unknown;
  error?: string;
};
type Receipt = { submissions: Submission[]; [key: string]: unknown };

async function main() {
  const file = path.join(process.cwd(), "eval", "results", "reppo-latest.json");
  if (!existsSync(file)) throw new Error("No Reppo receipt found. Run npm run eval:reppo first.");
  const receipt = JSON.parse(readFileSync(file, "utf8")) as Receipt;
  for (const item of receipt.submissions) {
    if (!item.evalId) continue;
    try {
      item.response = await getReppoEvaluation({ apiKey, evalId: item.evalId });
      delete item.error;
    } catch (error) {
      item.error = error instanceof Error ? error.message : "Unknown Reppo API error";
    }
    writeFileSync(file, JSON.stringify(receipt, null, 2));
    console.log(`${item.caseId} ${item.variant}: fetched ${item.evalId}`);
  }
  console.log(`Updated Reppo results in ${file}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The Reppo status check stopped.");
  process.exit(1);
});
