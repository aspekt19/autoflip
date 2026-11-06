import { randomUUID } from "node:crypto";
import type { Listing } from "@/domain/types";
import {
  checkWall,
  freezeBudgets,
  freshUsage,
  reserveProviderCalls,
  reserveServCall,
  reserveToolCall,
} from "./budgets";
import { flipEconomicsFor, personalFitFor } from "./economics";
import {
  askingPriceEvidence,
  assumedCostEvidence,
  historyEvidence,
  identityEvidence,
} from "./evidence";
import { runScoutGates } from "./gates";
import { validateScoutMandate } from "./mandate";
import { assertTransition, isTerminal } from "./transitions";
import type { InventoryAdapter } from "./inventory";
import {
  buildPlannerEvidenceContext,
  type ScoutPlannerEvidenceContext,
} from "./planner-context";
import {
  fingerprintSearchParams,
  mandateToSearchParams,
  validateScoutSearchParams,
  type ScoutSearchParams,
} from "./search-params";
import type {
  ProvenanceStep,
  ScoutBudgets,
  ScoutCandidate,
  ScoutFailReason,
  ScoutMandate,
  ScoutPlanAction,
  ScoutRunResult,
  ScoutState,
  ScoutToolId,
  ScoutToolCapability,
  ScoutToolOutcome,
} from "./types";
import { SCOUT_TOOL_IDS } from "./types";

function capabilityFromStatus(status: ScoutToolOutcome["status"]): ScoutToolCapability {
  if (status === "success") return "supported_executed";
  if (status === "unsupported") return "unsupported";
  if (status === "empty") return "empty";
  if (status === "idempotent_replay") return "idempotent_replay";
  // rejected / failed — no successful adapter execution
  return "failed";
}

export type ScoutPlannerInput = {
  mandate: ScoutMandate;
  pool: Listing[];
  pendingVins: string[];
  investigated: ScoutCandidate[];
  rejected: ScoutCandidate[];
  step: number;
  /** Recent actual tool outcomes — planner must replan from these, not invent success. */
  recentOutcomes: ScoutToolOutcome[];
  /** Stage2C: bounded facts/missingness/gates/confidence + search history. */
  evidenceContext: ScoutPlannerEvidenceContext;
};

export type ScoutPlanner = (input: ScoutPlannerInput) => Promise<
  | { ok: true; action: ScoutPlanAction }
  | { ok: false; error: "serv_refused" | "serv_timeout" | "serv_unavailable"; message: string }
>;

export type RunScoutInput = {
  ownerId: string;
  mandateRaw: unknown;
  budgets?: Partial<ScoutBudgets>;
  inventory: InventoryAdapter;
  planner: ScoutPlanner;
  now?: Date;
  runId?: string;
  /** Resume from a prior checkpoint (same owner only). */
  resume?: ScoutRunResult;
  /**
   * `serv_directed` = live/authorized SERV planner chose actions (HTTP scout_plan).
   * `none` = offline heuristic, mock script, or denied SERV — never marketed as autonomous SERV.
   * Default is `none` (fail-honest).
   */
  autonomyClaim?: "serv_directed" | "none";
};

type ToolCache = Map<string, ScoutToolOutcome>;

function stamp(
  provenance: ProvenanceStep[],
  state: ScoutState,
  reason: string,
  toolId: ScoutToolId | null = null,
  servStepId: string | null = null,
  idempotencyKey: string | null = null,
): void {
  provenance.push({
    at: new Date().toISOString(),
    state,
    toolId,
    reason,
    servStepId,
    idempotencyKey,
  });
}

function isToolId(id: string): id is ScoutToolId {
  return (SCOUT_TOOL_IDS as readonly string[]).includes(id);
}

function emptyCandidate(listing: Listing): ScoutCandidate {
  return {
    vin: listing.vin,
    listing,
    disposition: "pending",
    evidence: [],
    flip: null,
    gates: [],
    withheld: false,
    withholdReason: null,
    rejectReason: null,
    historyStatus: "unknown",
    historyEvaluated: false,
    claimsSafeBuy: false,
    claimsVerifiedProfit: false,
  };
}

/**
 * Normalize + gate a candidate for investigation (select or replace-acquire).
 * Deterministic constraints only — unknown history may allow investigate, never fake pass.
 */
function evaluateCandidateForInvestigation(input: {
  vin: string;
  cand: ScoutCandidate;
  pool: Listing[];
  mandate: ScoutMandate;
  budgets: ScoutBudgets;
  investigated: ScoutCandidate[];
  pending: string[];
  rejected: ScoutCandidate[];
  now: Date;
  provenance: ProvenanceStep[];
  state: ScoutState;
  toolId: ScoutToolId;
  servStepId: string;
  idem: string;
}): { ok: boolean; summary: string } {
  const cand = input.cand;
  const vin = input.vin;
  const listing = cand.listing;
  cand.evidence = [...identityEvidence(listing), askingPriceEvidence(listing)];
  const hist = historyEvidence(listing);
  cand.evidence.push(...hist.facts);
  cand.historyStatus = hist.historyStatus;
  cand.historyEvaluated = true;
  if (input.mandate.mode === "flip") {
    cand.flip = flipEconomicsFor(listing, input.pool, input.mandate, input.now);
    if (cand.flip?.assumption) cand.evidence.push(assumedCostEvidence(cand.flip.assumption));
    else cand.evidence.push(assumedCostEvidence(null));
  }
  const gate = runScoutGates({
    listing,
    mandate: input.mandate,
    flip: cand.flip,
    historyStatus: cand.historyStatus,
  });
  cand.gates = gate.gates;
  cand.withheld = gate.withheld;
  cand.withholdReason = gate.withholdReason;
  cand.claimsSafeBuy = false;
  cand.claimsVerifiedProfit = false;

  if (gate.allowInvestigate && input.investigated.length < input.budgets.maxCandidatesOut) {
    if (input.mandate.mode === "flip" && cand.flip?.excluded) {
      stamp(
        input.provenance,
        input.state,
        `Evaluated ${vin}; flip excluded (${cand.flip.excludeReason}).`,
        input.toolId,
        input.servStepId,
        input.idem,
      );
      return {
        ok: true,
        summary: `Acquired ${vin} but flip excluded (${cand.flip.excludeReason}) — left pending for planner reject/replace.`,
      };
    }
    cand.disposition = "investigate";
    if (!input.investigated.some((c) => c.vin === vin)) input.investigated.push(cand);
    const pIdx = input.pending.indexOf(vin);
    if (pIdx >= 0) input.pending.splice(pIdx, 1);
    stamp(
      input.provenance,
      input.state,
      `Accepted ${vin} as investigation candidate (not a verified buy).`,
      input.toolId,
      input.servStepId,
      input.idem,
    );
    return {
      ok: true,
      summary: `Acquired and accepted ${vin} as investigation candidate (not a verified buy/profit).`,
    };
  }
  if (!gate.allowInvestigate) {
    cand.disposition = "rejected";
    cand.rejectReason = gate.withholdReason ?? "Failed hard investigation gates.";
    input.rejected.push(cand);
    const pIdx = input.pending.indexOf(vin);
    if (pIdx >= 0) input.pending.splice(pIdx, 1);
    stamp(input.provenance, input.state, cand.rejectReason, "gates.verify", input.servStepId, input.idem);
    return { ok: false, summary: `Acquired ${vin} but rejected: ${cand.rejectReason}` };
  }
  return {
    ok: true,
    summary: `Acquired ${vin}; investigation cap reached — left pending.`,
  };
}

function fail(
  base: ScoutRunResult,
  reason: ScoutFailReason,
  message: string,
  partial = true,
): ScoutRunResult {
  if (!isTerminal(base.state)) {
    try {
      assertTransition(base.state, "failed");
    } catch {
      /* already failing from illegal path */
    }
  }
  const usage = {
    ...base.usage,
    wallEndedAtMs: base.usage.wallEndedAtMs ?? Date.now(),
  };
  return {
    ...base,
    usage,
    state: "failed",
    failReason: reason,
    message,
    partial,
    autonomyClaim: base.autonomyClaim,
  };
}

/**
 * Bounded SERV-directed scout loop. Deterministic code owns tools/gates/budgets.
 * Planner refusal/timeout → STOP (no silent deterministic autonomy claim).
 */
export async function runScout(input: RunScoutInput): Promise<ScoutRunResult> {
  const budgets = freezeBudgets(input.budgets);
  const now = input.now ?? new Date();
  /** Wall clock is always real time; `now` is only for listing-age / economics. */
  const wallClockMs = () => Date.now();
  const runId = input.runId ?? randomUUID();
  const autonomyClaim = input.autonomyClaim ?? "none";
  const provenance: ProvenanceStep[] = input.resume?.provenance
    ? [...input.resume.provenance]
    : [];
  const usage = input.resume
    ? { ...input.resume.usage }
    : freshUsage(wallClockMs());
  const toolCache: ToolCache = new Map();
  const recentOutcomes: ScoutToolOutcome[] = [];
  /** Full outcome log for Stage3 observables (planner still uses truncated recentOutcomes). */
  const toolOutcomes: ScoutToolOutcome[] = input.resume?.toolOutcomes
    ? [...input.resume.toolOutcomes]
    : [];
  /** Stage2C: fingerprints of inventory searches already performed (incl. initial). */
  const searchHistory: Array<{ fingerprint: string; params: ScoutSearchParams }> = [];
  let midLoopSearchCount = 0;

  let state: ScoutState = input.resume?.state ?? "created";
  let mandate: ScoutMandate | null = input.resume?.mandate ?? null;
  let pool: Listing[] = [];
  let inventorySource: ScoutRunResult["inventorySource"] = input.resume?.inventorySource ?? "none";
  let inventoryProvenance: string | null = input.resume?.inventoryProvenance ?? null;
  let inventoryIdentity: ScoutRunResult["inventoryIdentity"] = input.resume?.inventoryIdentity ?? {
    kind: "none",
    isFixture: false,
  };
  const candidates = new Map<string, ScoutCandidate>();
  const pending: string[] = [];
  const investigated: ScoutCandidate[] = [];
  const rejected: ScoutCandidate[] = [];

  const pushOutcome = (outcome: {
    toolId: ScoutToolId | string;
    vin: string | null;
    ok: boolean;
    status: ScoutToolOutcome["status"] | string;
    capability?: ScoutToolCapability;
    summary: string;
    acquiredVin: string | null;
    servStepId: string | null;
    freshVinCount?: number;
    searchFingerprint?: string | null;
  }): ScoutToolOutcome => {
    const status = outcome.status as ScoutToolOutcome["status"];
    const full: ScoutToolOutcome = {
      toolId: outcome.toolId as ScoutToolId,
      vin: outcome.vin,
      ok: outcome.ok,
      status,
      capability: outcome.capability ?? capabilityFromStatus(status),
      summary: outcome.summary,
      acquiredVin: outcome.acquiredVin,
      servStepId: outcome.servStepId,
      ...(outcome.freshVinCount != null ? { freshVinCount: outcome.freshVinCount } : {}),
      ...(outcome.searchFingerprint !== undefined
        ? { searchFingerprint: outcome.searchFingerprint }
        : {}),
    };
    toolOutcomes.push(full);
    recentOutcomes.push(full);
    // Keep a bounded window for planner context (not an unbounded log).
    if (recentOutcomes.length > 12) recentOutcomes.splice(0, recentOutcomes.length - 12);
    return full;
  };

  const recordSearch = (params: ScoutSearchParams, fingerprint: string) => {
    searchHistory.push({ params, fingerprint });
  };

  if (input.resume) {
    for (const c of input.resume.candidates) candidates.set(c.vin, { ...c, listing: c.listing });
    for (const c of input.resume.candidates) {
      if (c.disposition === "pending") pending.push(c.vin);
      if (c.disposition === "investigate") investigated.push(c);
      if (c.disposition === "rejected" || c.disposition === "replaced") rejected.push(c);
    }
  }

  const snapshot = (): ScoutRunResult => ({
    runId,
    ownerId: input.ownerId,
    state,
    mode: mandate?.mode ?? "flip",
    mandate: mandate!,
    budgets,
    usage: { ...usage },
    inventorySource,
    inventoryProvenance,
    inventoryIdentity,
    poolSize: pool.length,
    candidates: [...candidates.values()],
    investigation: investigated.filter((c) => c.disposition === "investigate"),
    provenance: [...provenance],
    toolOutcomes: [...toolOutcomes],
    failReason: null,
    message: null,
    autonomyClaim,
    partial: false,
  });

  // Ownership isolation on resume
  if (input.resume && input.resume.ownerId !== input.ownerId) {
    return fail(
      {
        runId,
        ownerId: input.ownerId,
        state: "failed",
        mode: "flip",
        mandate: {
          mode: "flip",
          budgetUsd: null,
          budgetKnown: false,
          targetProfitUsd: null,
          repairAbility: "unknown",
          preferredMakes: [],
          openToOtherMakes: true,
          zip: null,
          maxDistanceMiles: null,
          notes: null,
        },
        budgets,
        usage,
        inventorySource: "none",
        inventoryProvenance: null,
        inventoryIdentity: { kind: "none", isFixture: false },
        poolSize: 0,
        candidates: [],
        investigation: [],
        provenance,
        toolOutcomes: [...toolOutcomes],
        failReason: "unauthorized",
        message: "Cannot resume another owner's scout run.",
        autonomyClaim: "none",
        partial: false,
      },
      "unauthorized",
      "Cannot resume another owner's scout run.",
      false,
    );
  }

  // 1) Mandate
  if (state === "created") {
    const validated = validateScoutMandate(input.mandateRaw);
    if (!validated.ok) {
      stamp(provenance, state, validated.message);
      return fail(
        {
          ...snapshot(),
          mandate: {
            mode: "flip",
            budgetUsd: null,
            budgetKnown: false,
            targetProfitUsd: null,
            repairAbility: "unknown",
            preferredMakes: [],
            openToOtherMakes: true,
            zip: null,
            maxDistanceMiles: null,
            notes: null,
          },
        },
        "mandate_invalid",
        validated.message,
        false,
      );
    }
    mandate = validated.mandate;
    assertTransition(state, "mandate_validated");
    state = "mandate_validated";
    stamp(provenance, state, "Mandate validated.");
  }

  if (!mandate) {
    return fail(snapshot(), "invariant_violation", "Mandate missing after validation.", false);
  }

  // 2) Inventory — reserve tool/provider capacity BEFORE dispatch (never spend then budget_exhausted).
  if (state === "mandate_validated") {
    const wall = checkWall(budgets, usage, wallClockMs());
    if (!wall.ok) {
      stamp(provenance, state, wall.detail);
      return fail(snapshot(), "budget_exhausted", wall.detail);
    }
    const tool = reserveToolCall(budgets, usage);
    if (!tool.ok) {
      stamp(provenance, state, tool.detail, "inventory.search");
      return fail(snapshot(), "budget_exhausted", tool.detail);
    }
    // Pre-reserve worst-case one provider slot only when server budget allows any.
    const worstCaseProvider = budgets.maxProviderCalls > usage.providerCalls ? 1 : 0;
    if (worstCaseProvider > 0) {
      const pre = reserveProviderCalls(budgets, usage, worstCaseProvider);
      if (!pre.ok) {
        stamp(provenance, state, pre.detail, "inventory.search");
        return fail(snapshot(), "budget_exhausted", pre.detail);
      }
    } else if (budgets.maxProviderCalls <= 0) {
      stamp(
        provenance,
        state,
        "maxProviderCalls=0 — inventory adapters must not perform paid provider HTTP.",
        "inventory.search",
      );
    }

    const inv = await input.inventory(mandate);

    if (inv.providerCallsUsed > 0 && budgets.maxProviderCalls <= 0) {
      stamp(provenance, state, "Inventory spent provider calls under maxProviderCalls=0.", "inventory.search");
      return fail(
        snapshot(),
        "invariant_violation",
        "Inventory adapter spent provider calls while maxProviderCalls=0.",
      );
    }
    if (inv.providerCallsUsed === 0 && worstCaseProvider === 1) {
      // Cache hit / no network — refund pre-reserve (dispatch did not consume a slot).
      usage.providerCalls = Math.max(0, usage.providerCalls - 1);
    } else if (inv.providerCallsUsed > worstCaseProvider) {
      const extra = reserveProviderCalls(budgets, usage, inv.providerCallsUsed - worstCaseProvider);
      if (!extra.ok) {
        stamp(provenance, state, extra.detail, "inventory.search");
        return fail(snapshot(), "budget_exhausted", `${extra.detail} (already dispatched — partial).`, true);
      }
    }

    if (!inv.ok) {
      stamp(provenance, state, inv.message, "inventory.search");
      const reason: ScoutFailReason =
        inv.error === "inventory_empty"
          ? "inventory_empty"
          : inv.error === "inventory_unconfigured"
            ? "inventory_unconfigured"
            : "provider_unavailable";
      {
        const initialParams = mandateToSearchParams(mandate);
        const initialFp = fingerprintSearchParams(initialParams);
        recordSearch(initialParams, initialFp);
        pushOutcome({
          toolId: "inventory.search",
          vin: null,
          ok: false,
          status: inv.error === "inventory_empty" ? "empty" : "failed",
          summary: inv.message,
          acquiredVin: null,
          servStepId: null,
          freshVinCount: 0,
          searchFingerprint: initialFp,
        });
      }
      if (inv.error === "inventory_empty") {
        assertTransition(state, "inventory_loaded");
        state = "inventory_loaded";
        assertTransition(state, "abstained");
        state = "abstained";
        const snap = snapshot();
        return {
          ...snap,
          usage: { ...snap.usage, wallEndedAtMs: Date.now() },
          state: "abstained",
          message: inv.message,
          partial: false,
          autonomyClaim: "none",
        };
      }
      return fail(snapshot(), reason, inv.message);
    }
    pool = inv.listings;
    inventorySource = inv.source;
    inventoryProvenance = inv.provenance;
    inventoryIdentity = { kind: inv.source, isFixture: inv.source === "replay" };
    for (const listing of pool) {
      candidates.set(listing.vin, emptyCandidate(listing));
      pending.push(listing.vin);
    }
    assertTransition(state, "inventory_loaded");
    state = "inventory_loaded";
    {
      const initialParams = mandateToSearchParams(mandate);
      const initialFp = fingerprintSearchParams(initialParams);
      recordSearch(initialParams, initialFp);
      pushOutcome({
        toolId: "inventory.search",
        vin: null,
        ok: true,
        status: pool.length === 0 ? "empty" : "success",
        summary: `Inventory loaded: ${pool.length} listings (${inv.source}).`,
        acquiredVin: null,
        servStepId: null,
        freshVinCount: pool.length,
        searchFingerprint: initialFp,
      });
    }
    stamp(
      provenance,
      state,
      `Inventory loaded: ${pool.length} listings (${inv.source}).`,
      "inventory.search",
    );
    assertTransition(state, "selecting");
    state = "selecting";
    stamp(provenance, state, "Entering SERV-directed selection.");
  }

  // Resume mid-loop: rebuild pool from candidates
  if (!pool.length && candidates.size) {
    pool = [...candidates.values()].map((c) => c.listing);
  }

  let step = 0;
  while (!isTerminal(state) && step < budgets.maxToolCalls + budgets.maxServCalls + 5) {
    step += 1;
    const wall = checkWall(budgets, usage, wallClockMs());
    if (!wall.ok) {
      stamp(provenance, state, wall.detail);
      return fail(snapshot(), "budget_exhausted", wall.detail);
    }

    if (investigated.length >= budgets.maxCandidatesOut) {
      assertTransition(state, "finalizing");
      state = "finalizing";
      stamp(provenance, state, "Candidate cap reached; finalizing.");
      assertTransition(state, "completed");
      state = "completed";
      stamp(provenance, state, "Completed with investigation candidates.", "run.finalize");
      break;
    }

    if (state === "selecting" || state === "verifying" || state === "rejecting" || state === "replacing") {
      if (state === "rejecting" || state === "replacing" || state === "verifying") {
        assertTransition(state, "selecting");
        state = "selecting";
      }

      const servReserve = reserveServCall(budgets, usage);
      if (!servReserve.ok) {
        stamp(provenance, state, servReserve.detail);
        return fail(snapshot(), "budget_exhausted", servReserve.detail);
      }

      const evidenceContext = buildPlannerEvidenceContext({
        investigated: [...investigated],
        pendingSample: pending
          .slice(0, 3)
          .map((vin) => candidates.get(vin))
          .filter((c): c is ScoutCandidate => Boolean(c)),
        searchHistory,
        mandate,
        budgets,
        usage,
        recentOutcomes,
      });

      const plan = await input.planner({
        mandate,
        pool,
        pendingVins: [...pending],
        investigated: [...investigated],
        rejected: [...rejected],
        step,
        recentOutcomes: [...recentOutcomes],
        evidenceContext,
      });

      if (!plan.ok) {
        stamp(provenance, state, plan.message);
        return fail(snapshot(), plan.error, plan.message, true);
      }

      const action = plan.action;

      if (action.type === "abstain") {
        assertTransition(state, "finalizing");
        state = "finalizing";
        stamp(provenance, state, action.reason, null, action.servStepId);
        assertTransition(state, "abstained");
        state = "abstained";
        stamp(provenance, state, "Honest abstain.", "run.finalize", action.servStepId);
        break;
      }

      if (action.type === "finalize") {
        assertTransition(state, "finalizing");
        state = "finalizing";
        stamp(provenance, state, action.reason, "run.finalize", action.servStepId);
        if (investigated.length === 0) {
          assertTransition(state, "abstained");
          state = "abstained";
          stamp(provenance, state, "Finalize with zero investigation candidates → abstain.");
        } else {
          assertTransition(state, "completed");
          state = "completed";
          stamp(provenance, state, `Finalized ${investigated.length} investigation candidate(s).`);
        }
        break;
      }

      if (action.type === "reject") {
        const tool = reserveToolCall(budgets, usage);
        if (!tool.ok) {
          stamp(provenance, state, tool.detail, "candidate.reject", action.servStepId);
          return fail(snapshot(), "budget_exhausted", tool.detail);
        }
        assertTransition(state, "rejecting");
        state = "rejecting";
        const cand = candidates.get(action.vin);
        if (cand) {
          cand.disposition = "rejected";
          cand.rejectReason = action.reason;
          rejected.push(cand);
          const idx = pending.indexOf(action.vin);
          if (idx >= 0) pending.splice(idx, 1);
          const invIdx = investigated.findIndex((c) => c.vin === action.vin);
          if (invIdx >= 0) investigated.splice(invIdx, 1);
        }
        stamp(provenance, state, action.reason, "candidate.reject", action.servStepId);
        continue;
      }

      if (action.type === "replace") {
        const tool = reserveToolCall(budgets, usage);
        if (!tool.ok) {
          stamp(provenance, state, tool.detail, "candidate.replace", action.servStepId);
          return fail(snapshot(), "budget_exhausted", tool.detail);
        }
        assertTransition(state, "replacing");
        state = "replacing";
        const cand = candidates.get(action.vin);
        if (cand) {
          cand.disposition = "replaced";
          cand.rejectReason = action.reason;
          rejected.push(cand);
          const invIdx = investigated.findIndex((c) => c.vin === action.vin);
          if (invIdx >= 0) investigated.splice(invIdx, 1);
          const pIdx = pending.indexOf(action.vin);
          if (pIdx >= 0) pending.splice(pIdx, 1);
        }

        // Real replacement acquisition: execute next distinct pending candidate within this budgeted call.
        const nextVin = pending.find((vin) => vin !== action.vin) ?? null;
        if (!nextVin || !candidates.has(nextVin) || !mandate) {
          const outcome = {
            toolId: "candidate.replace",
            vin: action.vin,
            ok: false,
            status: "empty",
            summary: `${action.reason} — no distinct pending replacement candidate remains in pool.`,
            acquiredVin: null,
            servStepId: action.servStepId,
          };
          pushOutcome(outcome);
          stamp(provenance, state, outcome.summary, "candidate.replace", action.servStepId);
          assertTransition(state, "selecting");
          state = "selecting";
          continue;
        }

        const acquired = evaluateCandidateForInvestigation({
          vin: nextVin,
          cand: candidates.get(nextVin)!,
          pool,
          mandate,
          budgets,
          investigated,
          pending,
          rejected,
          now,
          provenance,
          state,
          toolId: "candidate.replace",
          servStepId: action.servStepId,
          idem: `replace-acquire:${action.vin}->${nextVin}`,
        });
        const outcome = {
          toolId: "candidate.replace",
          vin: action.vin,
          ok: acquired.ok,
          status: acquired.ok ? "success" : "failed",
          summary: acquired.summary,
          acquiredVin: nextVin,
          servStepId: action.servStepId,
        };
        pushOutcome(outcome);
        stamp(provenance, state, outcome.summary, "candidate.replace", action.servStepId);
        assertTransition(state, "verifying");
        state = "verifying";
        continue;
      }

      if (action.type === "select_candidate" || action.type === "run_tool") {
        const toolId: ScoutToolId =
          action.type === "select_candidate" ? "listing.normalize" : action.toolId;
        if (!isToolId(toolId)) {
          stamp(provenance, state, `Unknown tool ${toolId}`);
          return fail(snapshot(), "invariant_violation", `Tool not on allowlist: ${toolId}`);
        }

        const vin =
          action.type === "select_candidate"
            ? action.vin
            : action.vin ?? pending[0] ?? null;

        const idem =
          action.type === "run_tool"
            ? `${toolId}:${vin ?? "none"}:${JSON.stringify(action.args ?? {})}`
            : `select:${vin ?? "none"}`;

        assertTransition(state, "tool_running");
        state = "tool_running";

        const cached = toolCache.get(idem);
        if (cached) {
          // Idempotent replay — do not double-count; surface prior outcome (not a fresh success).
          const replay = {
            ...cached,
            status: "idempotent_replay",
            summary: `Idempotent replay of prior ${cached.status}: ${cached.summary}`,
            servStepId: action.servStepId,
          };
          pushOutcome(replay);
          stamp(provenance, state, replay.summary, toolId, action.servStepId, idem);
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        const tool = reserveToolCall(budgets, usage);
        if (!tool.ok) {
          stamp(provenance, state, tool.detail, toolId, action.servStepId, idem);
          return fail(snapshot(), "budget_exhausted", tool.detail);
        }

        // Stage2C: mid-loop inventory.search — validated bounded adjustment, real adapter when legitimate.
        if (toolId === "inventory.search") {
          if (!mandate) {
            toolCache.set(
              idem,
              pushOutcome({
                toolId,
                vin: null,
                ok: false,
                status: "failed",
                summary: "inventory.search requires a validated mandate.",
                acquiredVin: null,
                servStepId: action.servStepId,
              }),
            );
            stamp(provenance, state, "inventory.search requires a validated mandate.", toolId, action.servStepId, idem);
            assertTransition(state, "verifying");
            state = "verifying";
            continue;
          }

          const args = action.type === "run_tool" ? action.args : undefined;
          const validated = validateScoutSearchParams(args ?? {}, mandate, {
            priorFingerprints: searchHistory.map((s) => s.fingerprint),
            midLoopSearchCount,
          });
          if (!validated.ok) {
            const summary = `rejected_no_spend (${validated.reason}): ${validated.message}`;
            toolCache.set(
              idem,
              pushOutcome({
                toolId,
                vin: null,
                ok: false,
                status: "rejected",
                capability: "failed",
                summary,
                acquiredVin: null,
                servStepId: action.servStepId,
                freshVinCount: 0,
                searchFingerprint: null,
              }),
            );
            stamp(provenance, state, summary, toolId, action.servStepId, idem);
            assertTransition(state, "verifying");
            state = "verifying";
            continue;
          }

          const worstCaseProvider = budgets.maxProviderCalls > usage.providerCalls ? 1 : 0;
          if (worstCaseProvider > 0) {
            const pre = reserveProviderCalls(budgets, usage, worstCaseProvider);
            if (!pre.ok) {
              const summary = `rejected_no_spend (budget): ${pre.detail}`;
              toolCache.set(
                idem,
                pushOutcome({
                  toolId,
                  vin: null,
                  ok: false,
                  status: "rejected",
                  capability: "failed",
                  summary,
                  acquiredVin: null,
                  servStepId: action.servStepId,
                  freshVinCount: 0,
                  searchFingerprint: validated.fingerprint,
                }),
              );
              stamp(provenance, state, summary, toolId, action.servStepId, idem);
              assertTransition(state, "verifying");
              state = "verifying";
              continue;
            }
          }

          midLoopSearchCount += 1;
          const inv = await input.inventory(mandate, { search: validated.params });

          if (inv.providerCallsUsed === 0 && worstCaseProvider === 1) {
            usage.providerCalls = Math.max(0, usage.providerCalls - 1);
          } else if (inv.providerCallsUsed > worstCaseProvider) {
            const extra = reserveProviderCalls(
              budgets,
              usage,
              inv.providerCallsUsed - worstCaseProvider,
            );
            if (!extra.ok) {
              stamp(provenance, state, extra.detail, toolId, action.servStepId, idem);
            }
          }

          recordSearch(validated.params, validated.fingerprint);

          if (!inv.ok) {
            const summary = inv.message;
            toolCache.set(
              idem,
              pushOutcome({
                toolId,
                vin: null,
                ok: false,
                status: inv.error === "inventory_empty" ? "empty" : "failed",
                summary,
                acquiredVin: null,
                servStepId: action.servStepId,
                freshVinCount: 0,
                searchFingerprint: validated.fingerprint,
              }),
            );
            stamp(provenance, state, summary, toolId, action.servStepId, idem);
            assertTransition(state, "verifying");
            state = "verifying";
            continue;
          }

          inventorySource = inv.source;
          inventoryProvenance = inv.provenance;
          inventoryIdentity = { kind: inv.source, isFixture: inv.source === "replay" };
          let fresh = 0;
          for (const listing of inv.listings) {
            if (candidates.has(listing.vin)) continue;
            candidates.set(listing.vin, emptyCandidate(listing));
            pending.push(listing.vin);
            pool.push(listing);
            fresh += 1;
          }

          const summary =
            fresh > 0
              ? `Mid-loop inventory.search added ${fresh} fresh VIN(s) (source=${inv.source}; duplicates skipped).`
              : `Mid-loop inventory.search returned only duplicate VINs (source=${inv.source}).`;
          toolCache.set(
            idem,
            pushOutcome({
              toolId,
              vin: null,
              ok: true,
              status: fresh > 0 ? "success" : "empty",
              summary,
              acquiredVin: fresh > 0 ? pending[pending.length - fresh] ?? null : null,
              servStepId: action.servStepId,
              freshVinCount: fresh,
              searchFingerprint: validated.fingerprint,
            }),
          );
          stamp(provenance, state, summary, toolId, action.servStepId, idem);
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        // No invented title/history tools — gov adapters are truthful unsupported offline.
        if (toolId === "evidence.gov_recalls" || toolId === "evidence.gov_fuel") {
          if (vin && candidates.has(vin)) {
            candidates.get(vin)!.evidence.push({
              key: toolId,
              value: { status: "unsupported" },
              kind: "unknown",
              source: "gov",
              note: "UNSUPPORTED: gov lookup not executed (no paid spend this path). Not a successful evidence fetch.",
            });
          }
          const outcome = {
            toolId,
            vin,
            ok: false,
            status: "unsupported",
            summary: `${toolId} unsupported — not treated as successful evidence or cache-success.`,
            acquiredVin: null,
            servStepId: action.servStepId,
          };
          toolCache.set(idem, pushOutcome(outcome));
          stamp(provenance, state, outcome.summary, toolId, action.servStepId, idem);
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        if (!vin || !candidates.has(vin) || !mandate) {
          const outcome = {
            toolId,
            vin,
            ok: false,
            status: "failed",
            summary: "Planner selected unknown VIN or mandate missing — tool failed.",
            acquiredVin: null,
            servStepId: action.servStepId,
          };
          toolCache.set(idem, pushOutcome(outcome));
          stamp(provenance, state, outcome.summary, toolId, action.servStepId, idem);
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        const cand = candidates.get(vin)!;
        const listing = cand.listing;

        if (toolId === "evidence.asking_price") {
          cand.evidence.push(askingPriceEvidence(listing));
          const outcome = {
            toolId,
            vin,
            ok: true,
            status: "success",
            summary: `Recorded asking price seller claim for ${vin}.`,
            acquiredVin: null,
            servStepId: action.servStepId,
          };
          toolCache.set(idem, pushOutcome(outcome));
          stamp(provenance, state, outcome.summary, toolId, action.servStepId, idem);
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        if (toolId === "evidence.comps_ask" || toolId === "economics.flip_estimate") {
          const flip = flipEconomicsFor(listing, pool, mandate, now);
          cand.flip = flip;
          if (flip?.assumption) cand.evidence.push(assumedCostEvidence(flip.assumption));
          else cand.evidence.push(assumedCostEvidence(null));
          const outcome = {
            toolId,
            vin,
            ok: true,
            status: "success",
            summary: flip?.excluded
              ? `Flip estimate excluded for ${vin}: ${flip.excludeReason}`
              : `Flip/comps economics computed for ${vin} (asking comps, not sold prices).`,
            acquiredVin: null,
            servStepId: action.servStepId,
          };
          toolCache.set(idem, pushOutcome(outcome));
          stamp(provenance, state, outcome.summary, toolId, action.servStepId, idem);
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        if (toolId === "economics.personal_fit") {
          const fit = personalFitFor(listing, mandate);
          cand.evidence.push({
            key: "personal_budget_fit",
            value: fit.fitsBudget,
            kind: fit.fitsBudget == null ? "unknown" : "assumed",
            source: "domain.budgetFit",
            note: `${fit.reason} (computed fit — not independently verified).`,
          });
          const outcome = {
            toolId,
            vin,
            ok: true,
            status: "success",
            summary: `Personal fit assumed for ${vin}: ${fit.reason}`,
            acquiredVin: null,
            servStepId: action.servStepId,
          };
          toolCache.set(idem, pushOutcome(outcome));
          stamp(provenance, state, outcome.summary, toolId, action.servStepId, idem);
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        if (
          toolId === "gates.verify" ||
          toolId === "listing.normalize" ||
          action.type === "select_candidate"
        ) {
          const acquired = evaluateCandidateForInvestigation({
            vin,
            cand,
            pool,
            mandate,
            budgets,
            investigated,
            pending,
            rejected,
            now,
            provenance,
            state,
            toolId,
            servStepId: action.servStepId,
            idem,
          });
          const outcome = {
            toolId,
            vin,
            ok: acquired.ok,
            status: acquired.ok ? "success" : "failed",
            summary: acquired.summary,
            acquiredVin: vin,
            servStepId: action.servStepId,
          };
          toolCache.set(idem, pushOutcome(outcome));
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        // Allowlisted but not implemented as a real adapter here — truthful unsupported.
        const unsupported = {
          toolId,
          vin,
          ok: false,
          status: "unsupported",
          summary: `${toolId} has no executable adapter on this path — unsupported (not success).`,
          acquiredVin: null,
          servStepId: action.servStepId,
        };
        toolCache.set(idem, pushOutcome(unsupported));
        stamp(provenance, state, unsupported.summary, toolId, action.servStepId, idem);
        assertTransition(state, "verifying");
        state = "verifying";
        continue;
      }
    }

    stamp(provenance, state, `Stuck in unexpected state ${state}`);
    return fail(snapshot(), "invariant_violation", `Unexpected loop state ${state}`);
  }

  if (!isTerminal(state)) {
    stamp(provenance, state, "Loop ceiling reached without terminal state.");
    return fail(snapshot(), "budget_exhausted", "Scout loop ceiling reached.");
  }

  const finalSnap = snapshot();
  return {
    ...finalSnap,
    usage: { ...finalSnap.usage, wallEndedAtMs: Date.now() },
    investigation: investigated
      .filter((c) => c.disposition === "investigate")
      .slice(0, budgets.maxCandidatesOut),
    partial: state === "failed",
    message:
      state === "abstained"
        ? "No evidence-backed investigation candidates under current mandate and budgets."
        : state === "completed"
          ? `Returning ${Math.min(investigated.length, budgets.maxCandidatesOut)} investigation candidate(s).`
          : finalSnap.message,
  };
}

/** Mock planner for control-plumbing tests only — never efficacy evidence. */
export function mockServPlanner(script: ScoutPlanAction[]): ScoutPlanner {
  let i = 0;
  return async () => {
    const action = script[i++];
    if (!action) {
      return { ok: false, error: "serv_unavailable", message: "Mock SERV script exhausted." };
    }
    return { ok: true, action };
  };
}

export function refusingPlanner(
  error: "serv_refused" | "serv_timeout" | "serv_unavailable" = "serv_refused",
): ScoutPlanner {
  return async () => ({
    ok: false,
    error,
    message: `SERV ${error.replace("serv_", "")} — stopping without deterministic autonomy fallback.`,
  });
}

/**
 * Offline heuristic planner for demos when live SERV is not authorized.
 * Callers MUST set autonomyClaim: "none". Not an efficacy claim.
 * Stage2C: unsupported gov alone is NOT proof the car is bad — continue other checks /
 * pending VINs, or bounded inventory.search when pending is empty. Not blind VIN-walk only.
 */
export function heuristicOfflinePlanner(): ScoutPlanner {
  const seen = new Set<string>();
  let searchAttempted = false;
  return async ({ pendingVins, investigated, mandate, recentOutcomes, evidenceContext }) => {
    const last = recentOutcomes[recentOutcomes.length - 1] ?? null;

    // Fresh VINs from mid-loop search → investigate those next (evidence-directed).
    if (
      last?.toolId === "inventory.search" &&
      last.status === "success" &&
      last.freshVinCount &&
      last.freshVinCount > 0 &&
      last.acquiredVin &&
      pendingVins.includes(last.acquiredVin)
    ) {
      seen.add(last.acquiredVin);
      return {
        ok: true,
        action: {
          type: "select_candidate",
          vin: last.acquiredVin,
          reason: `Offline heuristic investigates fresh VIN from mid-loop search (autonomyClaim=none).`,
          servStepId: "offline-heuristic",
        },
      };
    }

    // Unsupported gov alone ≠ car bad — keep investigating same VIN with other tools / next pending.
    if (last && last.status === "unsupported" && last.toolId.startsWith("evidence.gov_")) {
      const brief = evidenceContext.evidenceBriefs.find((b) => b.vin === last.vin);
      const missingOther = (brief?.missingness ?? []).filter((m) => !m.startsWith("evidence.gov_"));
      if (last.vin && pendingVins.includes(last.vin) && missingOther.length > 0) {
        const nextTool = missingOther[0]!;
        const toolId =
          nextTool === "asking_price"
            ? "evidence.asking_price"
            : nextTool === "economics.flip_estimate"
              ? "economics.flip_estimate"
              : nextTool === "economics.personal_fit"
                ? "economics.personal_fit"
                : nextTool === "gates.verify"
                  ? "gates.verify"
                  : null;
        if (toolId) {
          return {
            ok: true,
            action: {
              type: "run_tool",
              toolId,
              vin: last.vin,
              reason: `Unsupported gov is not proof the car is bad — try ${toolId} next (autonomyClaim=none).`,
              servStepId: "offline-heuristic",
            },
          };
        }
      }
      // Fall through to next pending / search — do not force replace on gov unsupported alone.
    }

    // Hard tool failure (non-gov) still warrants moving on.
    if (last && last.status === "failed" && last.vin && pendingVins.includes(last.vin)) {
      return {
        ok: true,
        action: {
          type: "replace",
          vin: last.vin,
          reason: `Offline heuristic replaces after ${last.toolId} failed: ${last.summary}`,
          servStepId: "offline-heuristic",
        },
      };
    }

    if (last?.status === "empty" && last.toolId === "candidate.replace") {
      if (!searchAttempted && evidenceContext.budgetsRemaining.toolCalls > 0) {
        searchAttempted = true;
        const model = investigated[0]?.listing.model;
        return {
          ok: true,
          action: {
            type: "run_tool",
            toolId: "inventory.search",
            vin: null,
            reason: "Replace empty — try bounded mid-loop inventory.search before abstain.",
            servStepId: "offline-heuristic",
            args: {
              makes: mandate.preferredMakes.slice(0, 2),
              // Model filter changes fingerprint vs initial unscoped search (still in-mandate).
              models: model ? [model] : [],
              zip: mandate.zip,
              distanceMiles: mandate.maxDistanceMiles,
            },
          },
        };
      }
      return {
        ok: true,
        action: {
          type: investigated.length ? "finalize" : "abstain",
          reason: "Offline heuristic: replace found no distinct candidate — honest stop.",
          servStepId: "offline-heuristic",
        },
      };
    }

    if (
      pendingVins.length === 0 &&
      !searchAttempted &&
      evidenceContext.budgetsRemaining.toolCalls > 0 &&
      investigated.length > 0
    ) {
      searchAttempted = true;
      const model = investigated[0]?.listing.model;
      return {
        ok: true,
        action: {
          type: "run_tool",
          toolId: "inventory.search",
          vin: null,
          reason: "No pending VINs — bounded inventory.search adjustment (autonomyClaim=none).",
          servStepId: "offline-heuristic",
          args: {
            makes: mandate.preferredMakes.slice(0, 2),
            models: model ? [model] : [],
            zip: mandate.zip,
            distanceMiles: mandate.maxDistanceMiles,
          },
        },
      };
    }

    if (investigated.length >= 5 || pendingVins.length === 0) {
      return {
        ok: true,
        action: {
          type: investigated.length ? "finalize" : "abstain",
          reason: "Offline heuristic finished pending pool (autonomyClaim=none).",
          servStepId: "offline-heuristic",
        },
      };
    }
    const next = pendingVins.find((vin) => !seen.has(vin));
    if (!next) {
      return {
        ok: true,
        action: {
          type: investigated.length ? "finalize" : "abstain",
          reason: "No unseen pending VINs.",
          servStepId: "offline-heuristic",
        },
      };
    }
    seen.add(next);
    return {
      ok: true,
      action: {
        type: "select_candidate",
        vin: next,
        reason: `Offline heuristic selects next pending VIN for ${mandate.mode} investigation (not SERV).`,
        servStepId: "offline-heuristic",
      },
    };
  };
}
