/**
 * Agent find_cars — async create / status / get over the same Find match path as the site.
 * Balance is checked before work; one report credit settles only after success.
 */
import { createHash, randomUUID } from "node:crypto";
import type { StructuredNeed } from "@/domain/need";
import { creditBalance, creditEventSeen, creditSpend } from "@/io/credit-book";
import type { Kv } from "@/io/kv";
import { findSearchIdempotencyKey, findSearchSpendKey, storeFindSearchDelivery } from "@/server/find-search-credit";
import { runFindMatch, type FindMatchDeps, type FindMatchResult } from "@/server/find-match";
import { understandNeed, type UnderstandDeps } from "@/server/understand-need";
import type { AgentCaller } from "./agent-auth";
import { agentError, insufficientCreditsEnvelope, type AgentErrorEnvelope } from "./agent-envelope";
import { hashServSteps, writeAgentReceipt } from "./agent-receipts";
import { emptyAgentVerdict, wrapAgentSuccess, type AgentApiSuccess } from "./agent-result";

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
  result: AgentApiSuccess | null;
  need: StructuredNeed | null;
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

export type AgentFindDeps = FindMatchDeps & UnderstandDeps & { origin: string };

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

    const spent = await creditSpend(deps.kv, fresh.user_id, fresh.spend_key);
    if (!spent.ok && !(await creditEventSeen(deps.kv, fresh.spend_key))) {
      fresh.error = insufficientCreditsEnvelope(deps.origin, spent.balance);
      await mark(fresh, "failed", "failed");
      await saveRun(deps.kv, fresh);
      return fresh;
    }

    const listings = match.body.directions.flatMap((group) => group.listings);
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
    const pick = top[0]
      ? { key: top[0].vin, label: `${top[0].year} ${top[0].make} ${top[0].model}` }
      : null;

    const verdict = emptyAgentVerdict({
      pick,
      verdict: null,
      confidence: null,
      reasons: pick
        ? [{ evidenceId: "find_rank", text: match.body.headline ?? "Top listing from this search." }]
        : [],
      unknowns: match.body.emptyReason ? [String(match.body.emptyReason)] : [],
      serv_steps: [
        {
          decided: pick ? `Shortlist lead: ${pick.label}` : "No listing shortlisted",
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

    const receipt = await writeAgentReceipt(deps.kv, {
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
    });

    const success = wrapAgentSuccess({
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
      },
      checks_run: ["understand_need", "find_match", "price_badge"],
      credit_spent: true,
      credits: 1,
      free_check_spent: false,
      receipt_id: receipt.receipt_id,
      run_id: fresh.run_id,
      summary: match.body.headline ?? match.body.message,
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
      },
    });

    await storeFindSearchDelivery(deps.kv, fresh.spend_key, success as unknown as Record<string, unknown>);
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
  };
}

export function agentFindInputHash(input: AgentFindCreateInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}
