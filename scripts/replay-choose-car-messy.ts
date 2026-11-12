/**
 * Offline replay: extractServJson + validateFindDecide against messy SERV answers.
 * No live SERV call. Exit 1 if any fixture fails to yield a verdict.
 */
import {
  ALL_MESSY_DECIDE_ANSWERS,
  MESSY_EVIDENCE_IDS,
  MESSY_SHORTLIST_KEYS,
  MESSY_SHORTLIST_META,
} from "../test/golden/messy-decide-fixtures";
import { validateFindDecide } from "../src/domain/find-decide";
import { extractServJson } from "../src/domain/serv-json";

function main(): void {
  let failed = 0;
  for (const row of ALL_MESSY_DECIDE_ANSWERS) {
    try {
      const payload = extractServJson(row.text);
      const validated = validateFindDecide(payload, {
        shortlistKeys: [...MESSY_SHORTLIST_KEYS],
        allowedEvidenceIds: [...MESSY_EVIDENCE_IDS],
        askUsd: 17_000,
        fairValueUsd: 16_800,
        shortlist: [...MESSY_SHORTLIST_META],
      });
      if (!validated.ok) {
        failed += 1;
        console.error(`[fail] ${row.id}: ${JSON.stringify(validated.issues)}`);
        continue;
      }
      console.log(
        `[ok] ${row.id}: pick=${validated.decide.pickKey} action=${validated.decide.action} confidence=${validated.decide.confidence}`,
      );
    } catch (err) {
      failed += 1;
      console.error(`[fail] ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed > 0) {
    console.error(`replay-choose-car-messy: ${failed} fixture(s) failed`);
    process.exit(1);
  }
  console.log(`replay-choose-car-messy: ${ALL_MESSY_DECIDE_ANSWERS.length} fixtures ok`);
}

main();
