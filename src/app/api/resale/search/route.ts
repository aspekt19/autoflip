import { creditBalance, creditEventSeen } from "@/io/credit-book";
import { getKv } from "@/io/kv";
import { runtimeDeps } from "@/server/deps";
import { runResaleSearch } from "@/server/resale-search";
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

  try {
    const deps = runtimeDeps();
    let result: Awaited<ReturnType<typeof runResaleSearch>>;
    try {
      result = await runResaleSearch(body, {
        ...deps,
        kv,
        env: process.env,
        servKey: deps.servKey,
        servBaseUrl: deps.servBaseUrl,
        servModel: deps.servModel,
      });
    } catch {
      const paid = await creditEventSeen(kv, spendKey);
      await releaseInflight();
      return Response.json(
        {
          error: "search_failed",
          message: paid
            ? "The resale search did not finish. An earlier delivery already used 1 credit, and it was not refunded."
            : "The resale search did not finish. No credit was used.",
          balance: await creditBalance(kv, id),
          charged: false,
        },
        { status: 500 },
      );
    }

    if (!result.ok) {
      const paid = await creditEventSeen(kv, spendKey);
      await releaseInflight();
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
    return Response.json({
      ...delivery,
      balance: balanceAfter,
      charged: true,
    });
  } catch {
    await releaseInflight();
    return Response.json(
      {
        error: "search_failed",
        message: "The resale search did not finish. No credit was used.",
        balance: await creditBalance(kv, id),
        charged: false,
      },
      { status: 500 },
    );
  }
}
