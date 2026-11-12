/**
 * Agent find_cars — async create / status / get over the same Find/Resale SERV path as the site.
 * Personal mode uses the site decide path (free-gov → triage → decide → challenge).
 * Balance is checked before work; one report credit settles only after cars are delivered.
 */
import { createHash, randomUUID } from "node:crypto";
import type { StructuredNeed } from "@/domain/need";
import { topFlipCandidates } from "@/domain/flip-rank";
import { buildResaleCandidatePnls } from "@/domain/resale-pnl";
import { creditBalance, creditEventSeen, creditSpend } from "@/io/credit-book";
import type { Kv } from "@/io/kv";
import { findSearchIdempotencyKey, findSearchSpendKey, storeFindSearchDelivery } from "@/server/find-search-credit";
import { runFindDecideOrchestrator } from "@/server/find-decide-orchestrator";
import { runFindMatch, type FindMatchDeps, type FindMatchResult } from "@/server/find-match";
import {
  listingFactsFromCompsPool,
  listingsFromMatchDirections,
  mintFindSearchContextRecord,
  updateFindSearchContext,
} from "@/server/find-search-context";
import { understandNeed, type UnderstandDeps } from "@/server/understand-need";
import { decideResale } from "@/server/serv-plan-decide";
import type { AgentCaller } from "./agent-auth";
import { agentError, insufficientCreditsEnvelope, type AgentErrorEnvelope } from "./agent-envelope";
import { hashServSteps, writeAgentReceipt } from "./agent-receipts";
import type { DecisionProofRecord } from "@/domain/decision-proof-record";
import type { AgentVerdict } from "@/domain/agent-verdict-schema";
import { emptyAgentVerdict, wrapAgentSuccess, type AgentApiSuccess } from "./agent-result";
import type { Listing } from "@/domain/types";

export type AgentFindCreateInput = {
  text: string;
  mode?: "personal" | "flip";
  zip?: string | null;
  budgetUsd?: number | null;
  idempotencyKey?: string | null;
};

export type AgentFindRunStatus =
  | "queued"
  | "understanding_need"
  | "searching_listings"
  | "ranking"
  | "settling"
  | "completed"
  | "failed";

export type AgentFindRunRecord = {
  run_id: string;
  user_id: string;
  key_id: string;
  key_prefix: string;
  status: AgentFindRunStatus;
  current_step: string;
  completed_steps: string[];
  created_at: string;
  updated_at: string;
  idempotency_key: string;
  spend_key: string;
  input: AgentFindCreateInput;
  error: AgentErrorEnvelope | null;
  result: (AgentApiSuccess & { txHash?: string | null; payment?: string }) | null;
  need: StructuredNeed | null;
  /** Shared lemonless.decision_proof.v1 rows from need parse (+ settle when present). */
  proofRecords: DecisionProofRecord[];
};

function runKey(runId: string): string {
  return `agent:find:run:${runId}`;
}

function idemKey(userId: string, clientKey: string): string {
  return `agent:find:idem:${userId}:${clientKey}`;
}

async function saveRun(kv: Kv, run: AgentFindRunRecord): Promise<void> {
  run.updated_at = new Date().toISOString();
  await kv.set(runKey(run.run_id), JSON.stringify(run));
}

export async function readAgentFindRun(kv: Kv, runId: string): Promise<AgentFindRunRecord | null> {
  const raw = await kv.get(runKey(runId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentFindRunRecord;
  } catch {
    return null;
  }
}

export type AgentFindDeps = FindMatchDeps &
  UnderstandDeps & {
    origin: string;
    servKey?: string;
    servBaseUrl?: string;
    servModel?: string;
  };

export async function createAgentFindRun(
  caller: AgentCaller,
  input: AgentFindCreateInput,
  deps: AgentFindDeps,
): Promise<{ ok: true; run: AgentFindRunRecord } | { ok: false; status: number; body: AgentErrorEnvelope }> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) {
    return {
      ok: false,
      status: 400,
      body: agentError({
        error_code: "missing_text",
        message: "Send a natural-language request in text.",
        next_steps: {
          action: "provide_text",
          summary: "Describe the car you want (budget, ZIP, make/model hints).",
          request: {
            method: "POST",
            url: `${deps.origin}/api/v1/find`,
            body: { text: "Reliable SUV under $18k near 78701" },
          },
          docs: `${deps.origin}/developers`,
        },
      }),
    };
  }

  const clientKey = findSearchIdempotencyKey({ clientKey: input.idempotencyKey });
  const idem = idemKey(caller.userId, clientKey);
  const existing = await loadIdempotentFind(deps.kv, idem);
  if (existing === "pending") {
    return {
      ok: false,
      status: 409,
      body: agentError({
        error_code: "idempotency_in_progress",
        message: "A find with this Idempotency-Key is already starting.",
        credit_spent: false,
        retry_safe: true,
        next_steps: {
          action: "retry",
          summary: "Retry with the same Idempotency-Key to get the same run id.",
          request: {
            method: "POST",
            url: `${deps.origin}/api/v1/find`,
            headers: { "Idempotency-Key": clientKey },
            body: { text },
          },
        },
      }),
    };
  }
  if (existing && !(existing.status === "failed" && existing.error?.retry_safe)) {
    return { ok: true, run: existing };
  }
  if (existing?.status === "failed") await deps.kv.delete(idem);
  const claimed = await deps.kv.setNx(idem, "pending", { ttlMs: 120_000 });
  if (!claimed) {
    const again = await loadIdempotentFind(deps.kv, idem);
    if (again && again !== "pending") return { ok: true, run: again };
    return {
      ok: false,
      status: 409,
      body: agentError({
        error_code: "idempotency_in_progress",
        message: "A find with this Idempotency-Key is already starting.",
        credit_spent: false,
        retry_safe: true,
        next_steps: {
          action: "retry",
          summary: "Retry with the same Idempotency-Key to get the same run id.",
          request: {
            method: "POST",
            url: `${deps.origin}/api/v1/find`,
            headers: { "Idempotency-Key": clientKey },
            body: { text },
          },
        },
      }),
    };
  }

  const spendKey = findSearchSpendKey(caller.userId, `agent-find:${clientKey}`);
  if (await creditEventSeen(deps.kv, spendKey)) {
    // Prior successful settle for this idempotency key — recreate a completed pointer if needed.
  } else {
    const balance = await creditBalance(deps.kv, caller.userId);
    if (balance < 1) {
      await deps.kv.delete(idem);
      return { ok: false, status: 402, body: insufficientCreditsEnvelope(deps.origin, balance) };
    }
  }

  const run: AgentFindRunRecord = {
    run_id: randomUUID(),
    user_id: caller.userId,
    key_id: caller.keyId,
    key_prefix: caller.keyPrefix,
    status: "queued",
    current_step: "queued",
    completed_steps: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    idempotency_key: clientKey,
    spend_key: spendKey,
    input: { ...input, text, idempotencyKey: clientKey },
    error: null,
    result: null,
    need: null,
    proofRecords: [],
  };
  await saveRun(deps.kv, run);
  await deps.kv.set(idem, run.run_id);
  return { ok: true, run };
}

async function loadIdempotentFind(kv: Kv, key: string): Promise<AgentFindRunRecord | "pending" | null> {
  const id = await kv.get(key);
  if (!id) return null;
  if (id === "pending") return "pending";
  return readAgentFindRun(kv, id);
}

async function mark(
  run: AgentFindRunRecord,
  status: AgentFindRunStatus,
  label: string,
): Promise<void> {
  run.status = status;
  run.current_step = label;
  if (!run.completed_steps.includes(label) && status !== "failed" && status !== "queued") {
    run.completed_steps.push(label);
  }
}

function runtimeServKey(deps: AgentFindDeps): string | undefined {
  return deps.servKey?.trim() || process.env.SERV_API_KEY?.trim() || undefined;
}

export async function advanceAgentFindRun(
  runId: string,
  deps: AgentFindDeps,
): Promise<AgentFindRunRecord | null> {
  const run = await readAgentFindRun(deps.kv, runId);
  if (!run) return null;
  if (run.status === "completed" || run.status === "failed") return run;

  const lockKey = `agent:find:lock:${runId}`;
  const locked = await deps.kv.setNx(lockKey, "1", { ttlMs: 90_000 });
  if (!locked) return readAgentFindRun(deps.kv, runId);

  try {
    const fresh = (await readAgentFindRun(deps.kv, runId))!;
    if (fresh.status === "completed" || fresh.status === "failed") return fresh;

    await mark(fresh, "understanding_need", "understanding_need");
    await saveRun(deps.kv, fresh);

    const understood = await understandNeed(
      {
        text: fresh.input.text,
        mode: fresh.input.mode === "flip" ? "flip" : "personal",
        zip: fresh.input.zip,
        budgetUsd: fresh.input.budgetUsd,
        budgetKnown: typeof fresh.input.budgetUsd === "number",
      },
      deps,
    );
    if (!understood.ok) {
      fresh.error = agentError({
        error_code: understood.error,
        message: understood.message,
        credit_spent: false,
        retry_safe: false,
        next_steps: {
          action: "clarify_need",
          summary: understood.message,
          request: {
            method: "POST",
            url: `${deps.origin}/api/v1/find`,
            body: { text: "Toyota Camry under $15k near 33101" },
          },
        },
      });
      await mark(fresh, "failed", "failed");
      await saveRun(deps.kv, fresh);
      return fresh;
    }

    fresh.need = understood.need;
    fresh.proofRecords = understood.proofRecords ?? [];
    await mark(fresh, "searching_listings", "searching_listings");
    await saveRun(deps.kv, fresh);
    await mark(fresh, "ranking", "ranking");
    await saveRun(deps.kv, fresh);

    let match: FindMatchResult;
    try {
      match = await runFindMatch({ need: understood.need }, deps);
    } catch {
      fresh.error = agentError({
        error_code: "find_failed",
        message: "Find failed. No credit was spent.",
        credit_spent: false,
        retry_safe: true,
        next_steps: {
          action: "retry",
          summary: "Retry with the same Idempotency-Key. No credit was spent.",
          request: {
            method: "POST",
            url: `${deps.origin}/api/v1/find`,
            headers: { "Idempotency-Key": fresh.idempotency_key },
            body: { text: fresh.input.text },
          },
        },
      });
      await mark(fresh, "failed", "failed");
      await saveRun(deps.kv, fresh);
      return fresh;
    }

    if (!match.ok) {
      const errCode = typeof match.body.error === "string" ? match.body.error : "find_failed";
      const errMessage =
        typeof match.body.message === "string" ? match.body.message : "Find could not complete.";
      fresh.error = agentError({
        error_code: errCode,
        message: errMessage,
        credit_spent: false,
        retry_safe: match.status >= 500,
        next_steps: {
          action: "adjust_need",
          summary: errMessage,
          request: {
            method: "POST",
            url: `${deps.origin}/api/v1/find`,
            body: { text: fresh.input.text, zip: fresh.input.zip ?? "78701" },
          },
        },
      });
      await mark(fresh, "failed", "failed");
      await saveRun(deps.kv, fresh);
      return fresh;
    }

    await mark(fresh, "settling", "settling");
    await saveRun(deps.kv, fresh);

    const poolListings: Listing[] =
      match.body.compsPool.length > 0
        ? match.body.compsPool
        : match.body.directions.flatMap((group) => group.listings);
    const listings = match.body.directions.flatMap((group) => group.listings);
    const carsDelivered = listings.length > 0;
    const mode = fresh.input.mode === "flip" ? "flip" : "personal";
    const servKey = runtimeServKey(deps);

    let verdict: AgentVerdict = emptyAgentVerdict({
      pick: null,
      verdict: null,
      confidence: null,
      reasons: [],
      unknowns: match.body.emptyReason ? [String(match.body.emptyReason)] : [],
      serv_steps: [
        {
          decided: "No listing shortlisted",
          why: match.body.headline ?? match.body.message ?? "Find search completed with no cars delivered.",
          changed: null,
          evidenceIds: ["find_match"],
        },
      ],
      no_serv_step: true,
      serv_spend: {
        calls: 0,
        costNote: understood.source === "model" ? "Need parse may have used a model call." : null,
      },
    });

    // Same SERV plan/decide façade as site Resale / Find settle (PR A/B plug-in points).
    if (carsDelivered && mode === "flip") {
      const budgetUsd =
        typeof understood.need.budgetUsd === "number" && Number.isFinite(understood.need.budgetUsd)
          ? understood.need.budgetUsd
          : typeof fresh.input.budgetUsd === "number"
            ? fresh.input.budgetUsd
            : 15_000;
      const ranked = topFlipCandidates(poolListings, new Date(), 8, {
        repairAbility: understood.need.repairAbility,
        targetProfitUsd: understood.need.targetProfitUsd ?? null,
      });
      const pnls = buildResaleCandidatePnls(ranked, {
        repairAbility: understood.need.repairAbility,
      });
      const settled = await decideResale({
        candidates: pnls,
        budgetUsd,
        servKey,
        servBaseUrl: deps.servBaseUrl,
        model: deps.servModel,
        fetchImpl: deps.fetch,
      });
      fresh.proofRecords = [...fresh.proofRecords, ...(settled.proofRecords ?? [])];
      verdict = settled.agentVerdict;
    } else if (carsDelivered && mode === "personal") {
      // Same decide path as the site: mint owner-bound search context → free-gov →
      // find_triage → find_decide → find_challenge (POST /api/find/decide).
      const shown = listingsFromMatchDirections(match.body.directions);
      const compsPool =
        match.body.compsPool.length > 0
          ? listingFactsFromCompsPool(match.body.compsPool)
          : shown;
      let context = mintFindSearchContextRecord({
        userId: fresh.user_id,
        need: understood.need,
        listings: shown,
        compsPool,
        servNextCheckEnabled: false,
      });
      context = await updateFindSearchContext(deps.kv, context, { decidePathEnabled: true });
      const decided = await runFindDecideOrchestrator(
        { searchContextToken: context.token },
        {
          kv: deps.kv,
          userId: fresh.user_id,
          servKey,
          servBaseUrl: deps.servBaseUrl,
          servModel: deps.servModel,
          fetchImpl: deps.fetch,
        },
      );
      if (!decided.ok) {
        fresh.error = agentError({
          error_code: decided.error,
          message: decided.message,
          credit_spent: false,
          retry_safe: decided.status >= 500,
          next_steps: {
            action: "retry",
            summary: decided.message,
            request: {
              method: "POST",
              url: `${deps.origin}/api/v1/find`,
              headers: { "Idempotency-Key": fresh.idempotency_key },
              body: { text: fresh.input.text },
            },
          },
        });
        await mark(fresh, "failed", "failed");
        await saveRun(deps.kv, fresh);
        return fresh;
      }
      fresh.proofRecords = [...fresh.proofRecords, ...(decided.pickProofRecords ?? [])];
      verdict = decided.pickAgentVerdict;
    } else if (carsDelivered) {
      const top = listings[0]!;
      verdict = emptyAgentVerdict({
        pick: { key: top.vin, label: `${top.year} ${top.make} ${top.model}` },
        verdict: null,
        confidence: null,
        reasons: [{ evidenceId: "find_rank", text: match.body.headline ?? "Top listing from this search." }],
        unknowns: [],
        serv_steps: [
          {
            decided: `Shortlist lead: ${top.year} ${top.make} ${top.model}`,
            why: match.body.headline ?? match.body.message ?? "Find search completed.",
            changed: null,
            evidenceIds: ["find_match"],
          },
        ],
        no_serv_step: true,
        serv_spend: {
          calls: 0,
          costNote: understood.source === "model" ? "Need parse may have used a model call." : null,
        },
      });
    }

    // Debit only when cars are delivered — empty inventory never charges.
    let creditSpent = false;
    if (carsDelivered) {
      {
        const spent = await creditSpend(deps.kv, fresh.user_id, fresh.spend_key);
        if (!spent.ok && !(await creditEventSeen(deps.kv, fresh.spend_key))) {
          fresh.error = insufficientCreditsEnvelope(deps.origin, spent.balance);
          await mark(fresh, "failed", "failed");
          await saveRun(deps.kv, fresh);
          return fresh;
        }
        creditSpent = true;
      }
    }

    const top = listings.slice(0, 8).map((row) => ({
      vin: row.vin,
      year: row.year,
      make: row.make,
      model: row.model,
      trim: row.trim,
      priceUsd: row.priceUsd,
      miles: row.miles,
      badge: row.badge,
      vdp: row.vdp,
    }));

    const receipt = creditSpent
      ? await writeAgentReceipt(deps.kv, {
          key_id: fresh.key_id,
          key_prefix: fresh.key_prefix,
          user_id: fresh.user_id,
          tool: "find_cars",
          credit_spent: true,
          credits: 1,
          free_check_spent: false,
          serv_steps_hash: hashServSteps(verdict.serv_steps),
          idempotency_key: fresh.idempotency_key,
          run_id: fresh.run_id,
          summary: match.body.headline ?? match.body.message,
        })
      : null;

    const success = {
      ...wrapAgentSuccess({
        tool: "find_cars",
        verdict,
        subject: {
          need: understood.need,
          scope: match.body.scope,
          providerQueriesUsed: match.body.providerQueriesUsed,
        },
        comparables_summary: { n: match.body.compsPool.length, method: "find_match_comps_pool" },
        code_computed: {
          providerQueriesUsed: match.body.providerQueriesUsed,
          listingCount: listings.length,
          partialFailure: match.body.partialFailure,
          carsDelivered,
        },
        checks_run: carsDelivered
          ? [
              "understand_need",
              "find_match",
              mode === "flip" ? "resale_decide" : "find_decide",
              "price_badge",
            ]
          : ["understand_need", "find_match"],
        credit_spent: creditSpent,
        credits: creditSpent ? 1 : 0,
        free_check_spent: false,
        receipt_id: receipt?.receipt_id ?? "no_charge_empty_inventory",
        run_id: fresh.run_id,
        summary: match.body.headline ?? match.body.message,
        proofRecords: fresh.proofRecords,
        result: {
          sample: match.body.sample,
          emptyReason: match.body.emptyReason,
          message: match.body.message,
          headline: match.body.headline,
          nextStep: match.body.nextStep,
          scope: match.body.scope,
          listings: top,
          directions: match.body.directions.map((group) => ({
            id: group.direction.id,
            segment: group.direction.segment,
            coverage: group.coverage,
            listingCount: group.listings.length,
          })),
          proofRecords: fresh.proofRecords,
          carsDelivered,
        },
      }),
    };

    if (creditSpent) {
      await storeFindSearchDelivery(deps.kv, fresh.spend_key, success as unknown as Record<string, unknown>);
    }
    fresh.result = success;
    await mark(fresh, "completed", "completed");
    await saveRun(deps.kv, fresh);
    return fresh;
  } finally {
    await deps.kv.delete(lockKey);
  }
}

export async function agentFindStatusPayload(run: AgentFindRunRecord) {
  return {
    run_id: run.run_id,
    status: run.status,
    current_step: run.current_step,
    completed_steps: run.completed_steps,
    credit_spent: run.result?.credit_spent ?? false,
    error_code: run.error?.error_code ?? null,
    message: run.error?.message ?? null,
    proofRecords: run.proofRecords ?? [],
  };
}

export function agentFindInputHash(input: AgentFindCreateInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}
