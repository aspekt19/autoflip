import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateCases,
  livePaidAllowed,
  loadFindCases,
  main,
} from "./eval-serv-vs-baseline";

const FIXTURE = join(process.cwd(), "eval/comparison/fixtures/find-cases.json");

describe("eval-serv-vs-baseline", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    delete process.env.EVAL_SERV_VS_BASELINE_ALLOW_PAID;
    delete process.env.EVAL_SERV_VS_BASELINE_DRY_RUN;
  });

  it("loads find fixtures and dry-runs without paid calls", async () => {
    const cases = loadFindCases(FIXTURE);
    expect(cases.length).toBeGreaterThan(0);
    const report = await evaluateCases({
      cases: cases.slice(0, 2),
      fixturePath: FIXTURE,
      dryRun: true,
      nowIso: "2026-11-10T00:00:00.000Z",
    });
    expect(report.schemaVersion).toBe("lemonless.serv_vs_baseline.v1");
    expect(report.dryRun).toBe(true);
    expect(report.cases).toHaveLength(2);
    for (const row of report.cases) {
      const serv = row.arms.find((a) => a.arm === "serv_decision");
      const plain = row.arms.find((a) => a.arm === "plain_llm_baseline");
      expect(serv?.status).toBe("dry_run");
      expect(plain?.status).toBe("not_run");
      expect(plain?.rawResponse).toBeNull();
      expect(row.provenance.dryRun).toBe(true);
    }
  });

  it("main --dry-run writes JSON with provenance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serv-vs-baseline-"));
    dirs.push(dir);
    const out = join(dir, "out.json");
    const report = await main(["--dry-run", "--out", out, "--fixture", FIXTURE]);
    expect(report.dryRun).toBe(true);
    const written = JSON.parse(readFileSync(out, "utf8")) as typeof report;
    expect(written.summary.caseCount).toBe(report.summary.caseCount);
    expect(written.cases[0]?.provenance.fixturePath).toContain("find-cases.json");
  });

  it("refuses paid mode without allow flag", () => {
    delete process.env.EVAL_SERV_VS_BASELINE_ALLOW_PAID;
    delete process.env.SERV_API_KEY;
    expect(livePaidAllowed()).toBe(false);
  });
});
