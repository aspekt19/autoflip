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
} from "@/server/find-search-context";
import {
  findSearchIdempotencyKey,
  findSearchSpendKey,
  reserveFindSearchCredit,
} from "@/server/find-search-credit";
import { requireVerifiedAccountForFind } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Find / search — always paid (1 internal credit) for a new Show-cars search.
 * Requires the same verified Auth.js account as vehicle checks — anonymous
 * af_uid cookies cannot debit legacy balances or mint Find ownership.
 * Debit once, only after results (and the owner-bound search context) are
 * stored. A failed search does not debit. The same idempotency key does not
 * debit again and a later failure of that key does not refund the delivery.
 * Owned next-check rematches reuse searchContextToken and do not debit again.
 * The 3 free VIN / own-URL checks per verified account per UTC month never apply here.
 */
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

  // One idempotency key for this attempt. Reuse it on a network retry so a
  // delivered Find is not charged twice, and so a failed retry of that same
  // key cannot refund the original delivery.
  const idemKey = continuation
    ? null
    : findSearchIdempotencyKey({
        clientKey: body?.searchIdempotencyKey,
      });
  const spendKey = idemKey ? findSearchSpendKey(id, idemKey) : null;
  const alreadyPaid = spendKey ? await creditEventSeen(kv, spendKey) : false;

  let balanceAfter = await creditBalance(kv, id);
  // Gate before any provider work. A replay of a Find that already paid may
  // continue even when the balance is now zero.
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

  const deps = runtimeDeps();
  let result: Awaited<ReturnType<typeof runFindMatch>>;
  try {
    result = await runFindMatch(body, {
      ...deps,
      kv,
      env: process.env,
    });
  } catch {
    return Response.json(
      {
        error: "search_failed",
        message: "The search did not finish. No credit was used.",
        balance: balanceAfter,
        charged: false,
      },
      { status: 500 },
    );
  }

  if (!result.ok) {
    // Provider / validation failure — nothing was delivered, so do not debit.
    // Do not compensate an earlier successful delivery that shares this key.
    return Response.json(
      {
        ...result.body,
        balance: balanceAfter,
        charged: false,
      },
      { status: result.status },
    );
  }

  // Mint owner-bound analysis contexts for every visible card BEFORE the client
  // can call /api/report. Opaque tokens are the only find→report trust proof.
  // Debit only after this succeeds — a failed save must not charge.
  let searchContextToken: string | null = null;
  const servNextCheckEnabled = Boolean(deps.servKey);

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

      // Owner-bound search context for next-check (server authority — not client body).
      const validated = validateNeed(body?.need ?? {});
      if (validated.ok) {
        const shown = listingsFromMatchDirections(result.body.directions);
        const compsPool = Array.isArray(result.body.compsPool)
          ? listingFactsFromCompsPool(result.body.compsPool)
          : shown;
        const record = mintFindSearchContextRecord({
          userId: id,
          need: validated.need,
          refine: body?.refine ?? {},
          listings: shown,
          compsPool,
          servNextCheckEnabled,
        });
        await storeFindSearchContext(kv, record);
        searchContextToken = record.token;
      }
    }
  } catch {
    return Response.json(
      {
        error: "search_failed",
        message: "The search did not finish. No credit was used.",
        balance: balanceAfter,
        charged: false,
      },
      { status: 500 },
    );
  }

  let charged = false;
  if (!continuation && idemKey) {
    const reserved = await reserveFindSearchCredit(kv, id, idemKey);
    if (!reserved.ok) {
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
  }

  return Response.json(
    {
      ...result.body,
      searchContextToken,
      /** UI may auto-start next-check only when true — keyless must not masquerade. */
      servNextCheckEnabled: searchContextToken ? servNextCheckEnabled : false,
      balance: balanceAfter,
      charged,
      rematchContinuation: continuation,
    },
    { status: result.status },
  );
}
