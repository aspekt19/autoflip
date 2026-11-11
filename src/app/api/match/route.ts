import { findDecidePathEnabled } from "@/domain/find-decide-path";
import { findDeliveryChargesCredit } from "@/domain/find-delivery";
import { validateNeed } from "@/domain/need";
import { creditBalance, creditEventSeen } from "@/io/credit-book";
import { getKv } from "@/io/kv";
import { rememberFindAnalysisContexts } from "@/server/find-analysis-context";
import { runFindMatch } from "@/server/find-match";
import { runtimeDeps } from "@/server/deps";
import {
  listingFactsFromCompsPool,
  listingsFromMatchDirections,
  loadFindSearchContext,
  mintFindSearchContextRecord,
  storeFindSearchContext,
  updateFindSearchContext,
} from "@/server/find-search-context";
import {
  FIND_SEARCH_INFLIGHT_TTL_MS,
  findSearchIdempotencyKey,
  findSearchInflightKey,
  findSearchSpendKey,
  readFindSearchDelivery,
  reserveFindSearchCreditReliable,
  storeFindSearchDelivery,
  waitForFindSearchDelivery,
  type FindSearchDelivery,
} from "@/server/find-search-credit";
import { requireVerifiedAccountForFind } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Find / search — always paid (1 internal credit) for a new Show-cars search.
 * Requires the same verified Auth.js account as vehicle checks — anonymous
 * af_uid cookies cannot debit legacy balances or mint Find ownership.
 * Debit once, only after results and the owner-bound search context are stored.
 * A failed search does not debit. The same user-scoped idempotency key returns
 * the stored delivery — it does not search again, mint a second context, or
 * open a fresh paid-check budget. A later failure of that key does not refund.
 * Owned next-check rematches reuse searchContextToken and do not debit again.
 * The 3 free VIN / own-URL checks per verified account per UTC month never apply here.
 */
async function replayPaidDelivery(kv: ReturnType<typeof getKv>, userId: string, delivery: FindSearchDelivery) {
  const balance = await creditBalance(kv, userId);
  return Response.json({
    ...delivery,
    balance,
    charged: true,
    rematchContinuation: false,
  });
}

export async function POST(request: Request) {
  const access = await requireVerifiedAccountForFind();
  if (!access.ok) return access.response;
  const id = access.id;

  const body = (await request.json().catch(() => null)) as {
    need?: unknown;
    refine?: { make?: string; model?: string; yearMin?: number; yearMax?: number };
    searchIdempotencyKey?: string;
    /** When set and owned by this verified account, rematch continues without a second debit. */
    searchContextToken?: string;
  } | null;

  const kv = getKv();

  let continuation = false;
  const continuationToken = typeof body?.searchContextToken === "string" ? body.searchContextToken.trim() : "";
  if (continuationToken) {
    const loaded = await loadFindSearchContext(kv, { userId: id, token: continuationToken });
    continuation = loaded.ok;
  }

  // One idempotency key per user per Show-cars attempt. A network retry of
  // that key returns the stored delivery. It must not run the provider again
  // (that minted a second context and a fresh paid-check budget).
  const idemKey = continuation
    ? null
    : findSearchIdempotencyKey({
        clientKey: body?.searchIdempotencyKey,
      });
  const spendKey = idemKey ? findSearchSpendKey(id, idemKey) : null;
  const alreadyPaid = spendKey ? await creditEventSeen(kv, spendKey) : false;

  if (spendKey) {
    const cached = await readFindSearchDelivery(kv, spendKey);
    if (cached) return replayPaidDelivery(kv, id, cached);
  }

  let balanceAfter = await creditBalance(kv, id);
  // Gate before any provider work. A replay whose delivery is already stored
  // returned above, including when the balance is now zero.
  if (!continuation && !alreadyPaid && balanceAfter < 1) {
    return Response.json(
      {
        error: "credits_required",
        balance: balanceAfter,
        message: "Find search costs 1 report credit. Buy credits to search dealer listings.",
      },
      { status: 403 },
    );
  }

  const inflightKey = spendKey ? findSearchInflightKey(spendKey) : null;
  let holdInflight = false;
  if (inflightKey && spendKey) {
    const cached = await readFindSearchDelivery(kv, spendKey);
    if (cached) return replayPaidDelivery(kv, id, cached);
    holdInflight = await kv.setNx(inflightKey, "1", { ttlMs: FIND_SEARCH_INFLIGHT_TTL_MS });
    if (!holdInflight) {
      const waited = await waitForFindSearchDelivery(kv, spendKey, inflightKey);
      if (waited) return replayPaidDelivery(kv, id, waited);
      holdInflight = await kv.setNx(inflightKey, "1", { ttlMs: FIND_SEARCH_INFLIGHT_TTL_MS });
      if (!holdInflight) {
        return Response.json(
          {
            error: "search_in_progress",
            message: "That search is already running. Retry this same request in a moment. No extra credit was used.",
            balance: await creditBalance(kv, id),
            charged: false,
          },
          { status: 503 },
        );
      }
    }
    const cachedAfterLock = await readFindSearchDelivery(kv, spendKey);
    if (cachedAfterLock) {
      await kv.delete(inflightKey);
      holdInflight = false;
      return replayPaidDelivery(kv, id, cachedAfterLock);
    }
  }

  const releaseInflight = async () => {
    if (holdInflight && inflightKey) {
      holdInflight = false;
      await kv.delete(inflightKey);
    }
  };

  try {
    const deps = runtimeDeps();
    let result: Awaited<ReturnType<typeof runFindMatch>>;
    try {
      result = await runFindMatch(body, {
        ...deps,
        kv,
        env: process.env,
      });
    } catch {
      const paid = spendKey ? await creditEventSeen(kv, spendKey) : false;
      return Response.json(
        {
          error: "search_failed",
          message: paid
            ? "The search did not finish. An earlier delivery of this search already used 1 credit, and it was not refunded."
            : "The search did not finish. No credit was used.",
          balance: await creditBalance(kv, id),
          charged: false,
        },
        { status: 500 },
      );
    }

    if (!result.ok) {
      // Provider / validation failure — nothing was delivered, so do not debit.
      // Do not compensate an earlier successful delivery that shares this key.
      const paid = spendKey ? await creditEventSeen(kv, spendKey) : false;
      return Response.json(
        {
          ...result.body,
          balance: await creditBalance(kv, id),
          charged: false,
          ...(paid
            ? {
                message:
                  "This search was already delivered and the credit was already used. The retry did not finish, and the credit was not refunded.",
              }
            : {}),
        },
        { status: result.status },
      );
    }

    // Mint owner-bound analysis contexts for every visible card BEFORE the client
    // can call /api/report. Opaque tokens are the only find→report trust proof.
    // Debit only after this succeeds — a failed save must not charge.
    let searchContextToken: string | null = null;
    const decidePath = findDecidePathEnabled(process.env);
    // Decide path replaces the next-check auto-loop when SERV is keyed (or code fallback).
    const servNextCheckEnabled = Boolean(deps.servKey) && !decidePath;
    let decidePathEnabled = false;

    try {
      if (result.body.ok && Array.isArray(result.body.directions)) {
        const needZip =
          body?.need && typeof body.need === "object" && body.need !== null && "zip" in body.need
            ? typeof (body.need as { zip?: unknown }).zip === "string"
              ? (body.need as { zip: string }).zip
              : null
            : null;
        const listings = result.body.directions.flatMap((g) => g.listings);
        const tokens = await rememberFindAnalysisContexts(kv, id, listings, needZip);
        for (const group of result.body.directions) {
          for (const listing of group.listings) {
            const token = tokens.get(listing.vin.trim().toUpperCase());
            if (token) {
              (listing as { analysisContextToken?: string }).analysisContextToken = token;
            }
          }
        }

        // Owner-bound search context for next-check / decide (server authority — not client body).
        const validated = validateNeed(body?.need ?? {});
        if (validated.ok) {
          const shown = listingsFromMatchDirections(result.body.directions);
          const compsPool = Array.isArray(result.body.compsPool)
            ? listingFactsFromCompsPool(result.body.compsPool)
            : shown;
          const minted = mintFindSearchContextRecord({
            userId: id,
            need: validated.need,
            refine: body?.refine ?? {},
            listings: shown,
            compsPool,
            servNextCheckEnabled,
          });
          // Owned rematch keeps the same token and the paid-call counter.
          // A new token would open another hard cap of 8 SERV calls for free.
          let record = minted;
          if (continuation && continuationToken) {
            const prior = await loadFindSearchContext(kv, { userId: id, token: continuationToken });
            if (prior.ok) {
              record = {
                ...minted,
                token: prior.record.token,
                appliedCheckIds: prior.record.appliedCheckIds,
                freeGovReceipts: prior.record.freeGovReceipts,
                servPaidCalls: prior.record.servPaidCalls ?? 0,
                lastServShortlistFp: prior.record.lastServShortlistFp ?? null,
                decisionLog: prior.record.decisionLog ?? [],
                carChecks: prior.record.carChecks ?? [],
                servNextCheckEnabled: prior.record.servNextCheckEnabled && !decidePath,
                decidePathEnabled: prior.record.decidePathEnabled || decidePath,
                triageShortlistKeys: prior.record.triageShortlistKeys ?? [],
                triageRevisitUsed: prior.record.triageRevisitUsed ?? false,
                iat: prior.record.iat,
                exp: prior.record.exp,
              };
            }
          }
          if (decidePath) {
            record = await updateFindSearchContext(kv, record, {
              decidePathEnabled: true,
            });
            decidePathEnabled = true;
            searchContextToken = record.token;
          } else {
            await storeFindSearchContext(kv, record);
            searchContextToken = record.token;
          }
        }
      }
    } catch {
      return Response.json(
        {
          error: "search_failed",
          message: "The search did not finish. No credit was used.",
          balance: await creditBalance(kv, id),
          charged: false,
        },
        { status: 500 },
      );
    }

    // A paid Find must leave a context. Returning cards without one repeats the
    // "loop never starts" failure and still would have charged.
    if (!continuation && !searchContextToken) {
      return Response.json(
        {
          error: "search_failed",
          message: "The search did not finish. No credit was used.",
          balance: await creditBalance(kv, id),
          charged: false,
        },
        { status: 500 },
      );
    }

    // Never charge when no listing search ran or zero cars came back (REPORT_356a /
    // AUDIT R8). Shared gate with API v1 / MCP agent find.
    const providerQueriesUsed =
      typeof result.body.providerQueriesUsed === "number" ? result.body.providerQueriesUsed : 0;
    const listingCount = Array.isArray(result.body.directions)
      ? result.body.directions.reduce(
          (n, g) => n + (Array.isArray(g.listings) ? g.listings.length : 0),
          0,
        )
      : 0;
    const emptyReason =
      typeof result.body.emptyReason === "string" ? result.body.emptyReason : null;
    const deliveredSearch = findDeliveryChargesCredit({
      ok: result.body.ok === true,
      providerQueriesUsed,
      listingCount,
      emptyReason,
    });

    let charged = false;
    if (!continuation && idemKey && deliveredSearch) {
      const reserved = await reserveFindSearchCreditReliable(kv, id, idemKey);
      if (!reserved.ok) {
        if (reserved.reason === "busy") {
          return Response.json(
            {
              error: "search_busy",
              message: "The credit balance could not be updated. Retry this search in a moment. No credit was used.",
              balance: reserved.balance,
              charged: false,
            },
            { status: 503 },
          );
        }
        return Response.json(
          {
            error: "credits_required",
            balance: reserved.balance,
            message: "Find search costs 1 report credit. Buy credits to search dealer listings.",
          },
          { status: 403 },
        );
      }
      balanceAfter = reserved.balance;
      charged = true;
    } else if (!continuation && idemKey && !deliveredSearch) {
      // Honest empty delivery — keep tokens for rematch but do not debit.
      balanceAfter = await creditBalance(kv, id);
      charged = false;
      const honesty =
        emptyReason === "no_directions"
          ? "No model directions could be built for this note, so no listing search ran and no credit was used."
          : listingCount === 0
            ? "No cars came back from this search, so no credit was used."
            : "The search did not deliver listings, so no credit was used.";
      const prior = typeof result.body.message === "string" ? result.body.message.trim() : "";
      result.body.message =
        prior && !/no credit was used/i.test(prior)
          ? `${prior.replace(/\.*$/, "")}. ${honesty}`
          : prior || honesty;
    }

    const payload: FindSearchDelivery = {
      ...result.body,
      searchContextToken,
      /** UI may auto-start next-check only when true — keyless must not masquerade. */
      servNextCheckEnabled: searchContextToken ? servNextCheckEnabled : false,
      /** PR B: UI auto-starts /api/find/decide once instead of the next-check loop. */
      decidePathEnabled: searchContextToken ? decidePathEnabled : false,
      balance: balanceAfter,
      charged,
      rematchContinuation: continuation,
    };
    // Publish before the response so a concurrent retry observes this token
    // instead of starting a second provider search. A store miss still returns
    // the delivery the shopper already paid for.
    if (spendKey && charged) {
      try {
        await storeFindSearchDelivery(kv, spendKey, payload);
      } catch {
        /* debit already landed; the response below is the delivery */
      }
    }

    return Response.json(payload, { status: result.status });
  } finally {
    await releaseInflight();
  }
}
