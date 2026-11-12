/**
 * Source/AST-style enforcement for the SERV ↔ code boundary.
 *
 * These tests FAIL if classic decision paths or forbidden switches are reintroduced.
 * Prefer scanning production `src/` (exclude `*.test.ts`) so a reintroduced symbol
 * cannot hide in a comment-only "migration" stub that is still imported.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { findAgentLoopEnabled } from "@/domain/find-agent";
import { resaleAgentLoopEnabled } from "@/domain/resale-agent";
import {
  assertNoNonUserSetConstraints,
  buildUserIntent,
  serializeUserIntentConstraints,
} from "@/domain/serv-boundary";
import { buildServChatTurnBody, buildServResponsesTurnBody } from "@/server/serv/agent-chat-turn";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      walkTsFiles(abs, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (/\.test\.(ts|tsx)$/.test(name)) continue;
    out.push(abs);
  }
  return out;
}

function rel(abs: string): string {
  return relative(ROOT, abs).replace(/\\/g, "/");
}

function productionSources(): Array<{ path: string; text: string }> {
  return walkTsFiles(SRC).map((abs) => ({
    path: rel(abs),
    text: readFileSync(abs, "utf8"),
  }));
}

function stripCommentsAndStrings(src: string): string {
  // Rough strip so comment-only mentions do not count as reintroduction.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function hits(
  files: Array<{ path: string; text: string }>,
  re: RegExp,
  opts?: { codeOnly?: boolean; pathFilter?: (p: string) => boolean },
): string[] {
  const found: string[] = [];
  for (const f of files) {
    if (opts?.pathFilter && !opts.pathFilter(f.path)) continue;
    const body = opts?.codeOnly ? stripCommentsAndStrings(f.text) : f.text;
    if (re.test(body)) found.push(f.path);
  }
  return found;
}

describe("SERV boundary enforcement — classic Find fallback", () => {
  it("orchestrator never falls through to classic triage/decide after agent failure", () => {
    const text = readFileSync(join(SRC, "server/find-decide-orchestrator.ts"), "utf8");
    // Honest failure path must exist.
    expect(text).toMatch(/agent_loop_failed/);
    expect(text).toMatch(/No code fallback pick was published/);
    // After agent failure return, classic triage must not be the next statement in the agent block.
    const agentBlock = text.slice(text.indexOf("Agenti"), text.indexOf("Classic triage"));
    expect(agentBlock).toMatch(/return \{[\s\S]*error:\s*"agent_loop_failed"/);
    expect(agentBlock).not.toMatch(/await runFindTriageServ/);
    expect(agentBlock).not.toMatch(/await runFindDecideServ/);
  });

  it("production orchestrator must not call classic triage/decide when SERV agent path is active", () => {
    const files = productionSources();
    // Classic modules may remain for labelled e2e stub / no-key only; the agent-success
    // and agent-failure paths must not reference a silent classic fallback helper.
    const fallback = hits(files, /\bjob_agent_loop_fallback\b|\bclassicDecideFallback\b|\brunClassicFindDecide\b/);
    expect(fallback).toEqual([]);
  });
});

describe("SERV boundary enforcement — classic Resale fallback", () => {
  it("resale job never falls through to classic inventory after agent failure", () => {
    const text = readFileSync(join(SRC, "server/resale-job.ts"), "utf8");
    expect(text).toMatch(/job_agent_loop_failed/);
    expect(text).toMatch(/Never fall through to classic inventory/);
    expect(text).not.toMatch(/job_agent_loop_fallback/);
    // Failure return must be agent_loop_failed, not continue into runResaleSearch.
    const failIdx = text.indexOf("job_agent_loop_failed");
    expect(failIdx).toBeGreaterThan(0);
    const afterFail = text.slice(failIdx, failIdx + 900);
    expect(afterFail).toMatch(/error:\s*"agent_loop_failed"/);
    expect(afterFail).not.toMatch(/runResaleSearch\(/);
  });
});

describe("SERV boundary enforcement — agent-loop off switches removed", () => {
  it("FIND_AGENT_LOOP / RESALE_AGENT_LOOP are not read as enable switches", () => {
    const files = productionSources();
    const findHits = hits(files, /\bFIND_AGENT_LOOP\b/, {
      codeOnly: true,
      pathFilter: (p) => p.includes("find-agent") || p.includes("find-decide") || p.includes("resale"),
    });
    const resaleHits = hits(files, /\bRESALE_AGENT_LOOP\b/, {
      codeOnly: true,
      pathFilter: (p) => p.includes("resale-agent") || p.includes("resale-job"),
    });
    expect(findHits, `FIND_AGENT_LOOP code reads: ${findHits.join(", ")}`).toEqual([]);
    expect(resaleHits, `RESALE_AGENT_LOOP code reads: ${resaleHits.join(", ")}`).toEqual([]);
  });

  it("env FIND_AGENT_LOOP=0 / RESALE_AGENT_LOOP=0 cannot disable a keyed agent loop", () => {
    expect(findAgentLoopEnabled({ FIND_AGENT_LOOP: "0" }, { servKey: "sk" })).toBe(true);
    expect(resaleAgentLoopEnabled({ RESALE_AGENT_LOOP: "0" }, { servKey: "sk" })).toBe(true);
    expect(findAgentLoopEnabled({ FIND_AGENT_LOOP: "off" }, { servKey: "sk" })).toBe(true);
    expect(resaleAgentLoopEnabled({ RESALE_AGENT_LOOP: "false" }, { servKey: "sk" })).toBe(true);
  });
});

describe("SERV boundary enforcement — non-dirty constraints must not reach SERV", () => {
  it("defaults / null pads fail assertNoNonUserSetConstraints", () => {
    const intent = buildUserIntent({ note: "reliable car under $12,000" });
    const serialized = serializeUserIntentConstraints(intent);
    expect(serialized.radiusMi).toBeUndefined();
    expect(assertNoNonUserSetConstraints(serialized, intent).ok).toBe(true);

    const leaked = {
      ...serialized,
      radiusMi: { value: 100, provenance: "default" as const },
      yearMin: null,
    };
    const check = assertNoNonUserSetConstraints(leaked, intent);
    expect(check.ok).toBe(false);
  });
});

describe("SERV boundary enforcement — no pre-SERV hard row filter on agent inventory", () => {
  it("find-agent tools must not call enforceHard / applyHardGate", () => {
    const files = productionSources().filter((f) => f.path.startsWith("src/server/find-agent/"));
    const offenders = hits(files, /\b(enforceHard|applyHardGate)\b/, { codeOnly: true });
    expect(offenders).toEqual([]);
  });

  it("find-match must not use applyHardGate / enforceHard as a pre-SERV inventory gate", () => {
    // Classic inventory brain is deleted; find-match must not drop rows for product
    // hard filters before SERV chooses. (inventory-widen may remain for legacy tests
    // but must not be called from find-match — asserted via import scan below.)
    const files = productionSources().filter((f) => f.path === "src/server/find-match.ts");
    const offenders = hits(files, /\b(applyHardGate|enforceHard)\s*\(/, { codeOnly: true });
    expect(
      offenders,
      `pre-SERV hard gate still present in: ${offenders.join(", ")}`,
    ).toEqual([]);
    const importsWiden = hits(files, /\binventory-widen\b|\bfilterInventoryWithWiden\b/, {
      codeOnly: true,
    });
    expect(importsWiden).toEqual([]);
  });
});

describe("SERV boundary enforcement — Check code verdict shortcuts removed", () => {
  it("run-check must not define or call verdictFromBadge / screening fallback headline", () => {
    const files = productionSources().filter((f) => f.path.startsWith("src/server/check/"));
    const badge = hits(files, /\bverdictFromBadge\b/, { codeOnly: true });
    expect(badge, `verdictFromBadge still in: ${badge.join(", ")}`).toEqual([]);
  });

  it("headlineFromGuardedDecision must not publish screeningVerdict as the Check action", () => {
    const text = readFileSync(join(SRC, "server/check/run-check.ts"), "utf8");
    // If the helper remains, it must not fall back to code screening as the published verdict.
    if (text.includes("headlineFromGuardedDecision")) {
      const fn = text.slice(
        text.indexOf("function headlineFromGuardedDecision"),
        text.indexOf("function headlineFromGuardedDecision") + 1200,
      );
      expect(fn).not.toMatch(/verdict:\s*input\.screeningVerdict/);
      expect(fn).not.toMatch(/screeningVerdict\s+as\s+Verdict/);
    }
  });
});

describe("SERV boundary enforcement — reasoning_effort never none on SERV builders/profiles", () => {
  it("agent chat/responses builders never emit reasoning_effort none", () => {
    const chat = buildServChatTurnBody({
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "none",
    });
    expect(chat.reasoning_effort).not.toBe("none");

    const responses = buildServResponsesTurnBody({
      instructions: "sys",
      input: "hi",
      reasoning: { effort: "none" },
    });
    expect((responses.reasoning as { effort: string }).effort).not.toBe("none");
  });

  it("SERV profile / request builders must not set reasoningEffort to none", () => {
    const files = productionSources().filter(
      (f) =>
        f.path.startsWith("src/server/serv/") ||
        f.path === "src/domain/serv-boundary.ts" ||
        f.path.startsWith("src/server/find-agent/") ||
        f.path.startsWith("src/server/resale-agent/"),
    );
    // Allow the type union mentioning "none" only as an input to normalize away —
    // but object literals / assignments of reasoningEffort: "none" are forbidden.
    const offenders = hits(files, /reasoningEffort\s*:\s*["']none["']/, { codeOnly: true });
    const requestOffenders = hits(files, /reasoning_effort\s*:\s*["']none["']/, { codeOnly: true });
    expect(
      [...offenders, ...requestOffenders],
      `reasoning_effort none still set in: ${[...offenders, ...requestOffenders].join(", ")}`,
    ).toEqual([]);
  });
});

describe("SERV boundary enforcement — Radar prefilterListing removed", () => {
  it("prefilterListing must not exist or be called from Radar production code", () => {
    const files = productionSources().filter(
      (f) =>
        f.path.includes("radar") ||
        f.path.endsWith("src/domain/radar-watch.ts") ||
        f.path.endsWith("src/server/radar-cycle.ts"),
    );
    const offenders = hits(files, /\bprefilterListing\b/, { codeOnly: true });
    expect(offenders, `prefilterListing still in: ${offenders.join(", ")}`).toEqual([]);
  });
});
