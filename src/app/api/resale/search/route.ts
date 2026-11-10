import { creditBalance, creditEventSeen } from "@/io/credit-book";
import { getKv } from "@/io/kv";
import {
  makeResaleDeadline,
  RESALE_INTERNAL_BUDGET_MS,
  logResaleStage,
} from "@/domain/resale-deadline";
import { runtimeDeps } from "@/server/deps";
import { runResaleSearch, type ResaleSearchResult } from "@/server/resale-search";
import {
  findSearchIdempotencyKey,
  readResaleSearchDelivery,
  reserveResaleSearchCreditReliable,
  RESALE_SEARCH_INFLIGHT_TTL_MS,
  resaleSearchInflightKey,
  resaleSearchSpendKey,
  storeResaleSearchDelivery,
  waitForResaleSearchDelivery,
  type ResaleSearchDelivery,
} from "@/server/resale-search-credit";
import { requireVerifiedAccountForFind } from "@/server/session";

export const dynamic = "force-dynamic";
/**
 * Prod (Nov 2026) killed this route at 60s ("Task timed out after 60 seconds", CDN 504).
 * Current Vercel Fluid docs list Hobby maxDuration up to 300s — Fluid alone did not
 * prevent the observed 60s kill on this deployment. Keep maxDuration at 60 to match
 * the observed platform kill, and finish under ~50s internally so we always return JSON.
 */
export const maxDuration = 60;

/**
 * Resale search — 1 report credit per delivered search (same as Find).
 * Debit only after a successful delivery is stored. Failed search = no debit.
 * Same user-scoped idempotency key replays the stored delivery.
 */

async function replayPaidDelivery(kv: ReturnType<typeof getKv>, userId: string, delivery: ResaleSearchDelivery) {
  const balance = await creditBalance(kv, userId);
  return Response.json({
    ...delivery,
    balance,
    charged: true,
  });
}

function timeBudgetResult(): ResaleSearchResult {
  return {
    ok: false,
    status: 504,
    body: {
      error: "time_budget",
      message:
        "The resale search hit its ~50s time budget before finishing every agent step. No credit was used. Code will return inventory flips on retry when Auto.dev responds in time; late SERV steps are marked not run (time budget).",
      nextStep:
        "Retry with the same filters. Prefer a ZIP radius under 100 miles if inventory stays slow.",
    },
  };
}

export async function POST(request: Request) {
  const access = await requireVerifiedAccountForFind();
  if (!access.ok) return access.response;
  const id = access.id;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const kv = getKv();

  const idemKey = findSearchIdempotencyKey({
    clientKey: typeof body?.searchIdempotencyKey === "string" ? body.searchIdempotencyKey : null,
  });
  const spendKey = resaleSearchSpendKey(id, idemKey);
  const alreadyPaid = await creditEventSeen(kv, spendKey);

  const cached = await readResaleSearchDelivery(kv, spendKey);
  if (cached) return replayPaidDelivery(kv, id, cached);

  let balanceAfter = await creditBalance(kv, id);
  if (!alreadyPaid && balanceAfter < 1) {
    return Response.json(
      {
        error: "credits_required",
        balance: balanceAfter,
        message: "Resale search costs 1 report credit (same as Find). Buy credits to search flip inventory.",
      },
      { status: 403 },
    );
  }

  const inflightKey = resaleSearchInflightKey(spendKey);
  let holdInflight = await kv.setNx(inflightKey, "1", { ttlMs: RESALE_SEARCH_INFLIGHT_TTL_MS });
  if (!holdInflight) {
    const waited = await waitForResaleSearchDelivery(kv, spendKey, inflightKey);
    if (waited) return replayPaidDelivery(kv, id, waited);
    holdInflight = await kv.setNx(inflightKey, "1", { ttlMs: RESALE_SEARCH_INFLIGHT_TTL_MS });
    if (!holdInflight) {
      return Response.json(
        {
          error: "search_in_progress",
          message: "That resale search is already running. Retry this same request in a moment. No extra credit was used.",
          balance: await creditBalance(kv, id),
          charged: false,
        },
        { status: 503 },
      );
    }
    const cachedAfterLock = await readResaleSearchDelivery(kv, spendKey);
    if (cachedAfterLock) {
      await kv.delete(inflightKey);
      return replayPaidDelivery(kv, id, cachedAfterLock);
    }
  }

  const releaseInflight = async () => {
    if (holdInflight) {
      holdInflight = false;
      await kv.delete(inflightKey);
    }
  };

  const deadline = makeResaleDeadline(RESALE_INTERNAL_BUDGET_MS);
  logResaleStage("route_start", deadline.startedAtMs, { userScoped: true });

  try {
    const deps = runtimeDeps();
    let result: ResaleSearchResult;
    try {
      const searchPromise = runResaleSearch(body, {
        ...deps,
        kv,
        env: process.env,
        servKey: deps.servKey,
        servBaseUrl: deps.servBaseUrl,
        servModel: deps.servModel,
        deadline,
        internalBudgetMs: RESALE_INTERNAL_BUDGET_MS,
      });
      // Safety net: always resolve JSON before the Hobby 60s platform kill.
      const guardPromise = new Promise<ResaleSearchResult>((resolve) => {
        setTimeout(() => resolve(timeBudgetResult()), Math.max(500, deadline.remainingMs()));
      });
      result = await Promise.race([searchPromise, guardPromise]);
    } catch (err) {
      const paid = await creditEventSeen(kv, spendKey);
      await releaseInflight();
      const reason = err instanceof Error ? err.message.slice(0, 180) : "unexpected_error";
      logResaleStage("route_error", deadline.startedAtMs, { reason });
      return Response.json(
        {
          error: "search_failed",
          reason,
          message: paid
            ? `The resale search did not finish (${reason}). An earlier delivery already used 1 credit, and it was not refunded. Retry with the same request — it should replay the stored delivery.`
            : `The resale search did not finish (${reason}). No credit was used. Retry with the same filters; if Auto.dev is slow, try a tighter ZIP radius.`,
          nextStep: "Retry this search. Failed searches never debit a credit.",
          balance: await creditBalance(kv, id),
          charged: false,
        },
        { status: 500 },
      );
    }

    if (!result.ok) {
      const paid = await creditEventSeen(kv, spendKey);
      await releaseInflight();
      logResaleStage("route_fail", deadline.startedAtMs, {
        error: result.body.error,
        status: result.status,
      });
      return Response.json(
        {
          ...result.body,
          balance: await creditBalance(kv, id),
          charged: false,
          ...(paid
            ? {
                message:
                  "This resale search was already delivered and the credit was already used. The retry did not finish, and the credit was not refunded.",
              }
            : {}),
        },
        { status: result.status },
      );
    }

    const delivery: ResaleSearchDelivery = {
      ...result.body,
      searchIdempotencyKey: idemKey,
    };

    await storeResaleSearchDelivery(kv, spendKey, delivery);

    const reserved = await reserveResaleSearchCreditReliable(kv, id, idemKey);
    if (!reserved.ok && !alreadyPaid) {
      await releaseInflight();
      return Response.json(
        {
          error: "credits_required",
          balance: reserved.balance,
          message: "Resale search costs 1 report credit. Buy credits to search flip inventory.",
          charged: false,
        },
        { status: 403 },
      );
    }

    balanceAfter = reserved.balance;
    await releaseInflight();
    logResaleStage("route_ok", deadline.startedAtMs, {
      remainingMs: deadline.remainingMs(),
      charged: true,
    });
    return Response.json({
      ...delivery,
      balance: balanceAfter,
      charged: true,
    });
  } catch (err) {
    await releaseInflight();
    const reason = err instanceof Error ? err.message.slice(0, 180) : "unexpected_error";
    logResaleStage("route_outer_error", deadline.startedAtMs, { reason });
    return Response.json(
      {
        error: "search_failed",
        reason,
        message: `The resale search did not finish (${reason}). No credit was used. Retry with the same filters.`,
        nextStep: "Retry this search. Failed searches never debit a credit.",
        balance: await creditBalance(kv, id),
        charged: false,
      },
      { status: 500 },
    );
  }
}
