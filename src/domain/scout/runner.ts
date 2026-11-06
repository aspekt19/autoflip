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
} from "./types";
import { SCOUT_TOOL_IDS } from "./types";

export type ScoutPlanner = (input: {
  mandate: ScoutMandate;
  pool: Listing[];
  pendingVins: string[];
  investigated: ScoutCandidate[];
  rejected: ScoutCandidate[];
  step: number;
}) => Promise<
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

type ToolCache = Map<string, unknown>;

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
    claimsSafeBuy: false,
    claimsVerifiedProfit: false,
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
  return {
    ...base,
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

  let state: ScoutState = input.resume?.state ?? "created";
  let mandate: ScoutMandate | null = input.resume?.mandate ?? null;
  let pool: Listing[] = [];
  let inventorySource: ScoutRunResult["inventorySource"] = input.resume?.inventorySource ?? "none";
  let inventoryProvenance: string | null = input.resume?.inventoryProvenance ?? null;
  const candidates = new Map<string, ScoutCandidate>();
  const pending: string[] = [];
  const investigated: ScoutCandidate[] = [];
  const rejected: ScoutCandidate[] = [];

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
    poolSize: pool.length,
    candidates: [...candidates.values()],
    investigation: investigated.filter((c) => c.disposition === "investigate"),
    provenance: [...provenance],
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
        poolSize: 0,
        candidates: [],
        investigation: [],
        provenance,
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
      if (inv.error === "inventory_empty") {
        assertTransition(state, "inventory_loaded");
        state = "inventory_loaded";
        assertTransition(state, "abstained");
        state = "abstained";
        return {
          ...snapshot(),
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
    for (const listing of pool) {
      candidates.set(listing.vin, emptyCandidate(listing));
      pending.push(listing.vin);
    }
    assertTransition(state, "inventory_loaded");
    state = "inventory_loaded";
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

      const plan = await input.planner({
        mandate,
        pool,
        pendingVins: [...pending],
        investigated: [...investigated],
        rejected: [...rejected],
        step,
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
        // Relabel alone is not a replacement pull — planner must select_candidate next.
        stamp(
          provenance,
          state,
          `${action.reason} (replacement requires a following select_candidate; pending=${pending.length})`,
          "candidate.replace",
          action.servStepId,
        );
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
        if (!vin || !candidates.has(vin)) {
          stamp(provenance, state, "Planner selected unknown VIN.", toolId, action.servStepId);
          // Treat as rejectable planner mistake → continue if pending remains, else abstain path via next plan
          continue;
        }

        const idem =
          action.type === "run_tool"
            ? `${toolId}:${vin}:${JSON.stringify(action.args ?? {})}`
            : `select:${vin}`;

        assertTransition(state, "tool_running");
        state = "tool_running";

        if (toolCache.has(idem)) {
          // Idempotent hit — do not double-count tool budget
          stamp(provenance, state, "Idempotent tool replay.", toolId, action.servStepId, idem);
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        const tool = reserveToolCall(budgets, usage);
        if (!tool.ok) {
          stamp(provenance, state, tool.detail, toolId, action.servStepId, idem);
          return fail(snapshot(), "budget_exhausted", tool.detail);
        }

        const cand = candidates.get(vin)!;
        const listing = cand.listing;

        // Listing injection: treat as data only (already in pool object)
        if (toolId === "listing.normalize" || action.type === "select_candidate") {
          cand.evidence = [...identityEvidence(listing), askingPriceEvidence(listing)];
          const hist = historyEvidence(listing);
          cand.evidence.push(...hist.facts);
          cand.historyStatus = hist.historyStatus;
        }

        if (toolId === "evidence.asking_price") {
          cand.evidence.push(askingPriceEvidence(listing));
        }

        if (toolId === "evidence.comps_ask" || toolId === "economics.flip_estimate") {
          const flip = flipEconomicsFor(listing, pool, mandate, now);
          cand.flip = flip;
          if (flip?.assumption) cand.evidence.push(assumedCostEvidence(flip.assumption));
          else cand.evidence.push(assumedCostEvidence(null));
        }

        if (toolId === "economics.personal_fit") {
          const fit = personalFitFor(listing, mandate);
          cand.evidence.push({
            key: "personal_budget_fit",
            value: fit.fitsBudget,
            kind: fit.fitsBudget == null ? "unknown" : "verified",
            source: "domain.budgetFit",
            note: fit.reason,
          });
        }

        if (toolId === "evidence.gov_recalls" || toolId === "evidence.gov_fuel") {
          cand.evidence.push({
            key: toolId,
            value: { status: "unsupported" },
            kind: "unknown",
            source: "gov",
            note: "UNSUPPORTED: gov lookup not executed (paid-off / no spend). Not a successful evidence fetch.",
          });
          stamp(
            provenance,
            state,
            `${toolId} returned unsupported/unknown — not treated as successful evidence.`,
            toolId,
            action.servStepId,
            idem,
          );
        }

        if (
          toolId === "gates.verify" ||
          toolId === "listing.normalize" ||
          toolId === "economics.flip_estimate" ||
          action.type === "select_candidate"
        ) {
          if (!cand.flip && mandate.mode === "flip") {
            cand.flip = flipEconomicsFor(listing, pool, mandate, now);
          }
          if (!cand.evidence.length) {
            cand.evidence = [...identityEvidence(listing), askingPriceEvidence(listing)];
            const hist = historyEvidence(listing);
            cand.evidence.push(...hist.facts);
            cand.historyStatus = hist.historyStatus;
          }
          const gate = runScoutGates({
            listing,
            mandate,
            flip: cand.flip,
            historyStatus: cand.historyStatus,
          });
          cand.gates = gate.gates;
          cand.withheld = gate.withheld;
          cand.withholdReason = gate.withholdReason;
          cand.claimsSafeBuy = false;
          cand.claimsVerifiedProfit = false;

          if (gate.allowInvestigate && investigated.length < budgets.maxCandidatesOut) {
            // Weak candidates: flip excluded → leave pending for reject/replace by planner
            if (mandate.mode === "flip" && cand.flip?.excluded) {
              stamp(
                provenance,
                state,
                `Evaluated ${vin}; flip excluded (${cand.flip.excludeReason}).`,
                toolId,
                action.servStepId,
                idem,
              );
            } else {
              cand.disposition = "investigate";
              if (!investigated.some((c) => c.vin === vin)) investigated.push(cand);
              const pIdx = pending.indexOf(vin);
              if (pIdx >= 0) pending.splice(pIdx, 1);
              stamp(
                provenance,
                state,
                `Accepted ${vin} as investigation candidate (not a verified buy).`,
                toolId,
                action.servStepId,
                idem,
              );
            }
          } else if (!gate.allowInvestigate) {
            cand.disposition = "rejected";
            cand.rejectReason = gate.withholdReason ?? "Failed hard investigation gates.";
            rejected.push(cand);
            const pIdx = pending.indexOf(vin);
            if (pIdx >= 0) pending.splice(pIdx, 1);
            stamp(provenance, state, cand.rejectReason, "gates.verify", action.servStepId, idem);
          }
        }

        toolCache.set(idem, true);
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

  return {
    ...snapshot(),
    investigation: investigated
      .filter((c) => c.disposition === "investigate")
      .slice(0, budgets.maxCandidatesOut),
    partial: state === "failed",
    message:
      state === "abstained"
        ? "No evidence-backed investigation candidates under current mandate and budgets."
        : state === "completed"
          ? `Returning ${Math.min(investigated.length, budgets.maxCandidatesOut)} investigation candidate(s).`
          : snapshot().message,
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
 */
export function heuristicOfflinePlanner(): ScoutPlanner {
  const seen = new Set<string>();
  return async ({ pendingVins, investigated, mandate }) => {
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
          type: "finalize",
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
