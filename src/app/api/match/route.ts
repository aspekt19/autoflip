import { validateNeed } from "@/domain/need";
import { creditBalance } from "@/io/credit-book";
import { getKv } from "@/io/kv";
import { rememberFindAnalysisContexts } from "@/server/find-analysis-context";
import { runFindMatch } from "@/server/find-match";
import { runtimeDeps } from "@/server/deps";
import {
  listingsFromMatchDirections,
  loadFindSearchContext,
  mintFindSearchContextRecord,
  storeFindSearchContext,
} from "@/server/find-search-context";
import {
  findSearchIdempotencyKey,
  releaseFindSearchCredit,
  reserveFindSearchCredit,
} from "@/server/find-search-credit";
import { requireVerifiedAccountForFind } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Find / search — always paid (1 internal credit) for a new Show-cars search.
 * Requires the same verified Auth.js account as vehicle checks — anonymous
 * af_uid cookies cannot debit legacy balances or mint Find ownership.
 * Owned next-check rematches reuse searchContextToken and do not debit again.
 * Free monthly vehicle-check allotment never applies here.
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

  let spendKey: string | null = null;
  let balanceAfter = await creditBalance(kv, id);
  if (!continuation) {
    const idemKey = findSearchIdempotencyKey({
      clientKey: body?.searchIdempotencyKey,
    });
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
    spendKey = reserved.spendKey;
    balanceAfter = reserved.balance;
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
    if (spendKey) await releaseFindSearchCredit(kv, id, spendKey);
    return Response.json(
      {
        error: "search_failed",
        message: "The search did not finish. No credit was used.",
        balance: spendKey ? balanceAfter + 1 : balanceAfter,
      },
      { status: 500 },
    );
  }

  if (!result.ok) {
    // Provider / validation failure — do not keep the debit for a new paid search.
    if (spendKey) await releaseFindSearchCredit(kv, id, spendKey);
    return Response.json(
      {
        ...result.body,
        balance: spendKey ? balanceAfter + 1 : balanceAfter,
        charged: false,
      },
      { status: result.status },
    );
  }

  // Mint owner-bound analysis contexts for every visible card BEFORE the client
  // can call /api/report. Opaque tokens are the only find→report trust proof.
  let searchContextToken: string | null = null;
  const servNextCheckEnabled = Boolean(deps.servKey);

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
      const record = mintFindSearchContextRecord({
        userId: id,
        need: validated.need,
        refine: body?.refine ?? {},
        listings: listingsFromMatchDirections(result.body.directions),
        servNextCheckEnabled,
      });
      await storeFindSearchContext(kv, record);
      searchContextToken = record.token;
    }
  }

  return Response.json(
    {
      ...result.body,
      searchContextToken,
      /** UI may auto-start next-check only when true — keyless must not masquerade. */
      servNextCheckEnabled: searchContextToken ? servNextCheckEnabled : false,
      balance: balanceAfter,
      charged: Boolean(spendKey),
      rematchContinuation: continuation,
    },
    { status: result.status },
  );
}
