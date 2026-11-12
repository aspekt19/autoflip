import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUDIT_PARTIALS,
  MAIN_AUDIT,
  STALE_VERIFIED_SUMMARY_RE,
  assertCountsEqual,
  countAllPartials,
  countPartialFile,
  parseMainSummaryTable,
  parsePartialCountsTable,
  type FateCounts,
} from "./serv-boundary-audit-counts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function expectEqual(actual: FateCounts, expected: FateCounts, label: string) {
  try {
    assertCountsEqual(actual, expected, label);
  } catch (err) {
    expect.fail(err instanceof Error ? err.message : String(err));
  }
}

describe("serv-boundary audit doc honesty", () => {
  const { byKey, total } = countAllPartials(REPO_ROOT);

  it("each partial ## Counts table matches primary-fate row counts", () => {
    for (const partial of AUDIT_PARTIALS) {
      const fromRows = countPartialFile(REPO_ROOT, partial.file);
      const text = readFileSync(join(REPO_ROOT, partial.file), "utf8");
      const fromTable = parsePartialCountsTable(text);
      expect(fromTable, `${partial.file} missing ## Counts table`).not.toBeNull();
      expectEqual(fromRows, fromTable!, `${partial.file} ## Counts`);
      expectEqual(fromRows, byKey[partial.key], `${partial.key} cache`);
    }
  });

  it("main summary table matches partial row counts (and totals)", () => {
    const mainText = readFileSync(join(REPO_ROOT, MAIN_AUDIT), "utf8");
    const { rows, total: summaryTotal } = parseMainSummaryTable(mainText);
    expect(rows.length).toBe(AUDIT_PARTIALS.length);
    expect(summaryTotal, "main summary Total row").not.toBeNull();

    for (const partial of AUDIT_PARTIALS) {
      const row = rows.find((r) => r.label.includes(partial.file.replace("docs/", "")));
      expect(row, `summary row for ${partial.file}`).toBeTruthy();
      expectEqual(byKey[partial.key], row!.counts, `main summary ${partial.key}`);
    }
    expectEqual(total, summaryTotal!, "main summary Total");
  });

  it("partial point callouts in main audit match found counts", () => {
    const mainText = readFileSync(join(REPO_ROOT, MAIN_AUDIT), "utf8");
    for (const partial of AUDIT_PARTIALS) {
      const short = partial.file.replace("docs/", "");
      // Callouts look like: **`docs/serv-boundary-audit-find.md`** (120 points).
      const re = new RegExp(
        String.raw`${short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` +
          String.raw`\`?\*\*\s*\((\d+) points\)`,
      );
      const m = mainText.match(re);
      expect(m, `points callout for ${short}`).toBeTruthy();
      expect(Number(m![1])).toBe(byKey[partial.key].found);
    }
  });

  it("does not embed a stale hardcoded verified 139/85/209-style rollup", () => {
    const mainText = readFileSync(join(REPO_ROOT, MAIN_AUDIT), "utf8");
    expect(mainText).not.toMatch(STALE_VERIFIED_SUMMARY_RE);
    // Any second numeric rollup outside the summary table is forbidden if it
    // repeats found/removed/moved/kept as verified absolutes.
    expect(mainText).not.toMatch(
      /\*\*Removed \(verified this branch\):\*\*.*\*\*\d+\*\*/i,
    );
    expect(mainText).not.toMatch(/\*\*Found \(catalogued\):\*\*\s*\*\*\d+\*\*/i);
    expect(mainText).not.toMatch(
      /\*\*Moved into SERV \/ note provenance:\*\*\s*\*\*\d+\*\*/i,
    );
    expect(mainText).not.toMatch(/\*\*Kept as guardrails:\*\*\s*\*\*\d+\*\*/i);
  });
});
