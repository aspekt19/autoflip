/**
 * One live-eval Resale query through the agentic Resale loop.
 * Never charges report credits.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { runResaleAgentLoop, summarizeResaleAgentJournal } from "@/server/resale-agent/loop";
import { createGoldenFetch } from "../../test/golden/transport";
import { liveEvalJournalMeta } from "./journal-meta";
import { ESTIMATED_USD_PER_QUERY, type RunOneDeps } from "./run-one";
import type { GeneratedQuery, LiveEvalCaseResult } from "./types";

function parseBudgetUsd(note: string): number | null {
  const m =
    note.match(/\$\s*([\d,]+(?:\.\d+)?)\s*k\b/i) ||
    note.match(/under\s+\$?\s*([\d,]+)/i) ||
    note.match(/around\s+\$?\s*([\d,]+)/i) ||
    note.match(/max\s+\$?\s*([\d,]+)/i) ||
    note.match(/budget\s+is\s+\$?\s*([\d,]+)/i);
  if (!m?.[1]) return null;
  let n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (/k\b/i.test(m[0]) && n < 1000) n *= 1000;
  return Math.round(n);
}

export async function runOneResaleQuery(
  query: GeneratedQuery,
  deps: RunOneDeps,
): Promise<LiveEvalCaseResult> {
  const started = Date.now();
  const base: Omit<LiveEvalCaseResult, "ok" | "searchSpec" | "carsFound" | "pick" | "failure" | "proofRecords"> = {
    id: query.id,
    product: "resale",
    note: query.note,
    elapsedMs: 0,
    estimatedUsd: ESTIMATED_USD_PER_QUERY,
    fixtureDir: deps.fixtureRoot && deps.caseId ? `${deps.fixtureRoot}/${deps.caseId}` : null,
  };

  const servKey = deps.servKey ?? null;
  const autodevKey = deps.autodevKey ?? null;
  if (!servKey || !autodevKey) {
    return {
      ...base,
      ok: false,
      searchSpec: null,
      carsFound: 0,
      pick: null,
      failure: {
        step: "missing_keys",
        error: "missing_keys",
        message: "SERV_API_KEY and AUTODEV_API_KEY required for live eval.",
      },
      proofRecords: [],
      elapsedMs: Date.now() - started,
    };
  }

  let fetchImpl = deps.fetchImpl ?? fetch;
  if (deps.fixtureRoot && deps.caseId) {
    const golden = await createGoldenFetch({
      mode: "record",
      caseId: deps.caseId,
      root: deps.fixtureRoot,
      liveFetch: fetchImpl,
      secrets: deps.secrets ?? ([servKey, autodevKey].filter(Boolean) as string[]),
    });
    fetchImpl = golden.fetch;
  }

  const budgetUsd = parseBudgetUsd(query.note);
  const shopperContext = {
    zip: query.zip,
    distanceMiles: query.distanceMiles,
    budgetUsd,
    product: "resale",
  };

  const loopDeps = {
    servKey,
    autodevKey,
    fetch: fetchImpl,
    servBaseUrl: deps.servBaseUrl,
    budgetUsd,
    pnlOptions: { repairAbility: "unknown" as const },
    shopperContext,
    // Isolated quota/cache per parallel query.
    autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
  };

  // Stepped across request budgets (in-process here: fresh deadline each hop).
  let agent = await runResaleAgentLoop({
    note: query.note,
    shopperContext,
    deps: loopDeps,
  });
  for (let hop = 0; hop < 40 && "continue" in agent && agent.continue; hop += 1) {
    agent = await runResaleAgentLoop({
      note: query.note,
      shopperContext,
      deps: loopDeps,
      checkpoint: agent.checkpoint,
    });
  }

  const journal = summarizeResaleAgentJournal(agent.journal);
  const meta = liveEvalJournalMeta(agent.journal);
  const elapsedMs = Date.now() - started;

  if (deps.fixtureRoot && deps.caseId) {
    const dir = path.join(deps.fixtureRoot, deps.caseId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "provenance.json"),
      `${JSON.stringify(
        {
          product: "resale",
          note: query.note,
          ok: agent.ok,
          agentMode: agent.agentMode,
          toolRounds: agent.toolRounds,
          journal,
        },
        null,
        2,
      )}\n`,
    );
  }

  if (!agent.ok) {
    const lastServ = [...agent.journal].reverse().find((e) => e.kind === "serv");
    return {
      ...base,
      ok: false,
      searchSpec: null,
      carsFound: agent.knownVins.length,
      pick: null,
      failure: {
        step: "resale_agent",
        error: agent.error,
        message: agent.message,
        responseId: lastServ && lastServ.kind === "serv" ? lastServ.responseId : null,
      },
      proofRecords: [],
      elapsedMs,
      durationMs: elapsedMs,
      agentMode: agent.agentMode,
      toolRounds: agent.toolRounds,
      verdictReached: false,
      relaxedConditions: [],
      journalServCalls: journal.servCalls,
      journalToolCalls: journal.toolCalls,
      featuresActive: meta.featuresActive,
      featureRejections: meta.featureRejections,
      servResponseIds: meta.servResponseIds,
    };
  }

  const top = agent.verdict.picks[0] ?? null;
  const listing = top ? agent.listingsByVin.get(top.vin.toUpperCase()) : null;
  const label = listing
    ? [listing.year, listing.make, listing.model].filter(Boolean).join(" ") || null
    : null;
  return {
    ...base,
    ok: true,
    searchSpec: null,
    carsFound: agent.knownVins.length,
    pick: top
      ? {
          vin: top.vin,
          label,
          verdict: top.action,
          confidence: agent.verdict.confidence,
        }
      : {
          vin: null,
          label: null,
          verdict: agent.verdict.picks.length === 0 ? "pass" : null,
          confidence: agent.verdict.confidence,
        },
    failure: null,
    proofRecords: [],
    elapsedMs,
    durationMs: elapsedMs,
    agentMode: agent.agentMode,
    toolRounds: agent.toolRounds,
    verdictReached: agent.verdictReached,
    relaxedConditions: agent.relaxedConditions,
    journalServCalls: journal.servCalls,
    journalToolCalls: journal.toolCalls,
    featuresActive: meta.featuresActive,
    featureRejections: meta.featureRejections,
    servResponseIds: meta.servResponseIds,
  };
}
