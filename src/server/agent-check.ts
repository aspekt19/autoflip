/**
 * Agent check_car — same runCheck path as the site /api/check.
 * Settles free-check quota or a report credit only after success.
 */
import { freeCheckMonthKey } from "@/domain/free-check-quota";
import { isValidVin } from "@/domain/vin";
import { commitFreeCheck, freeCheckSlotsRemaining, releaseFreeCheck, reserveFreeCheck } from "@/io/free-check-quota";
import type { Kv } from "@/io/kv";
import { creditBalance } from "@/io/credit-book";
import { runCheck, type CheckRunDeps, type CheckRunInput, type CheckResultPayload } from "@/server/check/run-check";
import { spendReportCredit } from "./api-keys";
import { agentError, insufficientCreditsEnvelope, type AgentErrorEnvelope } from "./agent-envelope";
import { hashServSteps, writeAgentReceipt } from "./agent-receipts";
import { agentVerdictFromCheck, wrapAgentSuccess, type AgentApiSuccess } from "./agent-result";
import type { AgentCaller } from "./agent-auth";

export type AgentCheckInput = {
  vin?: string | null;
  url?: string | null;
  text?: string | null;
  optionalZip?: string | null;
  idempotencyKey?: string | null;
};

export type AgentCheckDeps = CheckRunDeps & { kv: Kv; origin: string };

export type AgentCheckOutcome =
  | { ok: true; body: AgentApiSuccess }
  | { ok: false; status: number; body: AgentErrorEnvelope };

function toRunInput(input: AgentCheckInput): CheckRunInput | { error: AgentErrorEnvelope } {
  const zip = input.optionalZip ?? null;
  if (input.vin && String(input.vin).trim()) {
    const vin = String(input.vin).trim().toUpperCase();
    if (!isValidVin(vin)) {
      return {
        error: agentError({
          error_code: "invalid_vin",
          message: "Enter a valid 17-character VIN.",
          next_steps: {
            action: "fix_vin",
            summary: "Send a checksum-valid 17-character VIN, or a listing URL / pasted text instead.",
            request: { method: "POST", url: "/api/v1/check", body: { vin: "4T1BF1FK0EU848445" } },
          },
        }),
      };
    }
    return { kind: "vin", vin, optionalZip: zip };
  }
  // Pasted text wins over URL so agents can supply HTML without triggering a live fetch.
  if (input.text && String(input.text).trim()) {
    return {
      kind: "paste",
      text: String(input.text),
      url: input.url ?? null,
      optionalZip: zip,
    };
  }
  if (input.url && String(input.url).trim()) {
    return { kind: "link", url: String(input.url).trim(), optionalZip: zip };
  }
  return {
    error: agentError({
      error_code: "missing_subject",
      message: "Send vin, url, or text for check_car.",
      next_steps: {
        action: "provide_subject",
        summary: "Include one of vin, url (listing link), or text (pasted listing).",
        request: {
          method: "POST",
          url: "/api/v1/check",
          body: { url: "https://dealer.example/inventory/camry" },
        },
      },
    }),
  };
}

function checkIdemKey(userId: string, clientKey: string): string {
  return `agent:check:idem:${userId}:${clientKey}`;
}

function checkLockKey(userId: string, clientKey: string): string {
  return `agent:check:lock:${userId}:${clientKey}`;
}

async function readCachedCheck(kv: Kv, userId: string, clientKey: string): Promise<AgentApiSuccess | null> {
  const raw = await kv.get(checkIdemKey(userId, clientKey));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AgentApiSuccess;
    if (!parsed || parsed.tool !== "check_car" || typeof parsed.receipt_id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function runAgentCheck(
  caller: AgentCaller,
  input: AgentCheckInput,
  deps: AgentCheckDeps,
): Promise<AgentCheckOutcome> {
  const parsed = toRunInput(input);
  if ("error" in parsed) return { ok: false, status: 400, body: parsed.error };

  const month = freeCheckMonthKey();
  const suppliedKey = input.idempotencyKey?.trim().slice(0, 80) || null;
  const clientKey = suppliedKey || crypto.randomUUID();
  if (suppliedKey) {
    const cached = await readCachedCheck(deps.kv, caller.userId, clientKey);
    if (cached) return { ok: true, body: cached };
    const locked = await deps.kv.setNx(checkLockKey(caller.userId, clientKey), "1", { ttlMs: 60_000 });
    if (!locked) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const replay = await readCachedCheck(deps.kv, caller.userId, clientKey);
        if (replay) return { ok: true, body: replay };
      }
      return {
        ok: false,
        status: 409,
        body: agentError({
          error_code: "idempotency_in_progress",
          message: "A check with this Idempotency-Key is already running.",
          credit_spent: false,
          retry_safe: true,
          next_steps: {
            action: "retry",
            summary: "Retry with the same Idempotency-Key. A completed check is returned without a second charge.",
            request: { method: "POST", url: `${deps.origin}/api/v1/check`, headers: { "Idempotency-Key": clientKey } },
          },
        }),
      };
    }
  }
  let freeCheckKey: string | null = null;
  let usedFreeCheck = false;
  let needsCredit = false;

  const subjectKey =
    parsed.kind === "vin"
      ? parsed.vin
      : parsed.kind === "link"
        ? `url:${Buffer.from(parsed.url).toString("base64url").slice(0, 24)}`
        : `paste:${Buffer.from(parsed.text.slice(0, 64)).toString("base64url").slice(0, 24)}`;

  // Gate before work. Settle free-check / credit only after a delivered result.
  {
    const slots = await freeCheckSlotsRemaining(deps.kv, caller.userId);
    if (slots.remaining < 1 && (await creditBalance(deps.kv, caller.userId)) < 1) {
      return { ok: false, status: 402, body: insufficientCreditsEnvelope(deps.origin, 0) };
    }
  }

  try {
    const result = await runCheck(parsed, deps);
    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        body: agentError({
          error_code: result.error,
          message: result.message,
          credit_spent: false,
          retry_safe: result.status >= 500 || result.blocked === true,
          next_steps: {
            action: result.blocked ? "paste_or_vin" : "fix_input",
            summary: result.message,
            request: {
              method: "POST",
              url: `${deps.origin}/api/v1/check`,
              body: result.blocked
                ? { text: "Paste the listing title, price, mileage, and VIN here." }
                : { vin: "4T1BF1FK0EU848445" },
            },
            docs: `${deps.origin}/developers`,
          },
        }),
      };
    }

    const vinKey =
      result.result.vin && isValidVin(result.result.vin) ? result.result.vin : subjectKey;
    freeCheckKey = `free-check:agent-check:${caller.userId}:${month}:${vinKey}:${clientKey}`;
    const reserved = await reserveFreeCheck(deps.kv, caller.userId, freeCheckKey);
    if (reserved.ok) usedFreeCheck = true;
    else if (reserved.reason === "lock_busy") {
      return {
        ok: false,
        status: 503,
        body: agentError({
          error_code: "quota_busy",
          message: "Could not reserve a free vehicle check right now. Retry in a moment.",
          credit_spent: false,
          retry_safe: true,
          next_steps: {
            action: "retry",
            summary: "Retry with the same Idempotency-Key in a few seconds.",
            request: { method: "POST", url: `${deps.origin}/api/v1/check`, body: input as Record<string, unknown> },
          },
        }),
      };
    } else if ((await creditBalance(deps.kv, caller.userId)) < 1) {
      return { ok: false, status: 402, body: insufficientCreditsEnvelope(deps.origin, 0) };
    } else needsCredit = true;

    let creditSpent = false;
    let credits = 0;
    if (needsCredit) {
      const spendKey = `agent-check:${caller.userId}:${month}:${clientKey}:${subjectKey}`.slice(0, 180);
      const spent = await spendReportCredit(deps.kv, caller.userId, spendKey);
      if (!spent.ok) {
        if (usedFreeCheck && freeCheckKey) await releaseFreeCheck(deps.kv, caller.userId, freeCheckKey);
        return { ok: false, status: 402, body: insufficientCreditsEnvelope(deps.origin, spent.balance) };
      }
      creditSpent = true;
      credits = 1;
    }
    if (usedFreeCheck && freeCheckKey) await commitFreeCheck(deps.kv, caller.userId, freeCheckKey);

    const verdict = agentVerdictFromCheck(result.result);
    const receipt = await writeAgentReceipt(deps.kv, {
      key_id: caller.keyId,
      key_prefix: caller.keyPrefix,
      user_id: caller.userId,
      tool: "check_car",
      credit_spent: creditSpent,
      credits,
      free_check_spent: usedFreeCheck,
      serv_steps_hash: hashServSteps(verdict.serv_steps),
      idempotency_key: clientKey,
      run_id: null,
      summary: result.result.summary,
    });

    const body = wrapAgentSuccess({
        tool: "check_car",
        verdict,
        subject: subjectFromCheck(result.result),
        comparables_summary: {
          n: result.result.compCount,
          method: "evaluateListingPrice",
          // PR108 always exposes walkAwayUsd on CheckResultPayload (null when unknown).
          walk_away_usd: result.result.walkAwayUsd,
        },
        code_computed: {
          fairValueUsd: result.result.fairValueUsd,
          priceGap: result.result.priceGap,
          compCount: result.result.compCount,
        },
        checks_run: [
          "listing_extract",
          "price_badge",
          "red_flags",
          result.result.vin ? "vin_decode" : "no_vin",
          result.result.recallsAvailable ? "nhtsa_recalls" : "recalls_unavailable",
        ],
        credit_spent: creditSpent,
        credits,
        free_check_spent: usedFreeCheck,
        receipt_id: receipt.receipt_id,
        summary: result.result.summary,
        // Shared lemonless.decision_proof.v1 — empty only when SERV was not configured / not called.
        proofRecords: result.result.proofRecords,
        result: result.result,
      });
    if (suppliedKey) await deps.kv.set(checkIdemKey(caller.userId, clientKey), JSON.stringify(body));
    return { ok: true, body };
  } catch {
    if (usedFreeCheck && freeCheckKey) await releaseFreeCheck(deps.kv, caller.userId, freeCheckKey);
    return {
      ok: false,
      status: 500,
      body: agentError({
        error_code: "check_failed",
        message: "Check failed. No credit was spent.",
        retry_safe: true,
        next_steps: {
          action: "retry",
          summary: "Retry with the same Idempotency-Key. No credit was spent.",
          request: { method: "POST", url: `${deps.origin}/api/v1/check`, body: input as Record<string, unknown> },
        },
      }),
    };
  } finally {
    if (suppliedKey) await deps.kv.delete(checkLockKey(caller.userId, clientKey));
  }
}

function subjectFromCheck(check: CheckResultPayload): Record<string, unknown> {
  return {
    kind: check.kind,
    title: check.title,
    vin: check.vin,
    year: check.fields?.year.value ?? check.vinDecode?.year ?? null,
    make: check.fields?.make.value ?? check.vinDecode?.make ?? null,
    model: check.fields?.model.value ?? check.vinDecode?.model ?? null,
    trim: check.fields?.trim.value ?? null,
    priceUsd: check.fields?.priceUsd.value ?? null,
    miles: check.fields?.miles.value ?? null,
  };
}
