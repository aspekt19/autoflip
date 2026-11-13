import { findDecidePathEnabled } from "@/domain/find-decide-path";
import { findDeliveryChargesCredit } from "@/domain/find-delivery";
import type { SearchDirection } from "@/domain/directions";
import { findPlanToServHint, type FindPlan } from "@/domain/find-plan";
import { pickUserFormConstraints } from "@/domain/constraint-provenance";
import { buildSearchSpec } from "@/domain/search-spec";
import { validateNeed } from "@/domain/need";
import { creditBalance, creditEventSeen } from "@/io/credit-book";
import { getKv } from "@/io/kv";
import { rememberFindAnalysisContexts } from "@/server/find-analysis-context";
import { runFindMatch } from "@/server/find-match";
import { readRun } from "@/io/run-store";
import { listingFromCar, syncRunSafely } from "@/server/run-sync";
import { runtimeDeps } from "@/server/deps";
import {
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
  storeFindSearchDelivery,
  waitForFindSearchDelivery,
  type FindSearchDelivery,
} from "@/server/find-search-credit";
import {
  commitSearchCreditOnDelivery,
  creditsRequiredBody,
  releaseSearchCredit,
  reserveSearchCreditBeforeServ,
} from "@/server/search-billing-gate";
import { requireVerifiedAccountForFind } from "@/server/session";

export const dynamic = "force-dynamic";
/** Pro/Fluid allows up to 300s — inventory + decide handoff must not die at Hobby 60s. */
export const maxDuration = 300;

/**
 * Find / search — always paid (1 internal credit) for a new Show-cars search.
 * Requires the same verified Auth.js account as vehicle checks — anonymous
 * af_uid cookies cannot debit legacy balances or mint Find ownership.
 * Reserve 1 credit BEFORE SERV; commit on delivered cars; release on empty/error.
 * The same user-scoped idempotency key returns the stored delivery.
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
    /** Provenanced form bag — only origin "user" becomes SearchSpec form edits. */
    constraints?: import("@/domain/search-spec").SearchFormEdits;
    searchIdempotencyKey?: string;
    runId?: string;
    /** C1 find_plan — owns SearchSpec hard vs soft when present. */
    findPlan?: FindPlan;
    directions?: SearchDirection[];
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
  let reservedSpendKey: string | null = alreadyPaid && spendKey ? spendKey : null;
  // Reserve BEFORE any provider/SERV work. Replay of a paid delivery returned above.
  if (!continuation && idemKey && !alreadyPaid) {
    const reserved = await reserveSearchCreditBeforeServ(kv, "find", id, idemKey);
    if (!reserved.ok) {
      return Response.json(creditsRequiredBody({ balance: reserved.balance, surface: "find" }), {
        status: 403,
      });
    }
    reservedSpendKey = reserved.spendKey;
    balanceAfter = reserved.balance;
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
      if (reservedSpendKey && !alreadyPaid) {
        balanceAfter = (await releaseSearchCredit(kv, id, reservedSpendKey)).balance;
      }
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
      // Provider / validation failure — release reservation unless this key already delivered.
      const priorDelivery = spendKey ? await readFindSearchDelivery(kv, spendKey) : null;
      if (reservedSpendKey && !priorDelivery && !alreadyPaid) {
        balanceAfter = (await releaseSearchCredit(kv, id, reservedSpendKey)).balance;
      }
      return Response.json(
        {
          ...result.body,
          balance: balanceAfter,
          charged: false,
          ...(priorDelivery
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
          // Same as eval/live/run-one: empty seed → agent loop owns search via
          // search_listings. Match directions remain for UI cards only
          // (display paging/diversity OK). Never seed SERV from post-budget /
          // post-odo / diversify-8 filtered lists.
          const minted = mintFindSearchContextRecord({
            userId: id,
            need: validated.need,
            refine: body?.refine ?? {},
            listings: [],
            compsPool: [],
            servNextCheckEnabled,
            // Display filters stay UI-only — empty seed above. User form bag travels separately.
            userFormEdits: body?.constraints ? pickUserFormConstraints(body.constraints) : null,
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
                // Prefer fresh bag from this rematch; fall back to prior stored edits.
                userFormEdits: minted.userFormEdits ?? prior.record.userFormEdits ?? null,
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
      if (reservedSpendKey && !alreadyPaid) {
        balanceAfter = (await releaseSearchCredit(kv, id, reservedSpendKey)).balance;
      }
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

    // A paid Find must leave a context. Returning cards without one repeats the
    // "loop never starts" failure — release the reservation.
    if (!continuation && !searchContextToken) {
      if (reservedSpendKey && !alreadyPaid) {
        balanceAfter = (await releaseSearchCredit(kv, id, reservedSpendKey)).balance;
      }
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

    // Commit when cars delivered; release on empty / plan failure / nothing-fits.
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
    const priorRun = typeof body?.runId === "string" ? await readRun(kv, body.runId) : null;
    const planFailed = Boolean(
      priorRun?.steps.some((step) => step.step === "plan_search" && step.status === "failed") ||
        priorRun?.failureReasons.includes("could_not_plan"),
    );
    const deliveredSearch =
      !planFailed &&
      findDeliveryChargesCredit({
        ok: result.body.ok === true,
        providerQueriesUsed,
        listingCount,
        emptyReason,
      });

    let charged = false;
    if (!continuation && idemKey && reservedSpendKey && deliveredSearch) {
      const committed = await commitSearchCreditOnDelivery(kv, id, reservedSpendKey);
      balanceAfter = committed.balance;
      charged = committed.committed;
      if (!charged) {
        balanceAfter = (await releaseSearchCredit(kv, id, reservedSpendKey)).balance;
        return Response.json(
          creditsRequiredBody({ balance: balanceAfter, surface: "find" }),
          { status: 403 },
        );
      }
    } else if (!continuation && idemKey && reservedSpendKey && (planFailed || !deliveredSearch)) {
      balanceAfter = (await releaseSearchCredit(kv, id, reservedSpendKey)).balance;
      charged = false;
      const honesty = planFailed
        ? "We could not plan this search, so there is no verdict and no credit was used."
        : emptyReason === "no_directions"
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
    const validatedNeed = validateNeed(body?.need ?? {});
    const note = validatedNeed.ok ? validatedNeed.need.note : "";
    const mode = validatedNeed.ok && validatedNeed.need.mode === "flip" ? "flip" : "personal";
    const listings = Array.isArray(result.body.directions)
      ? result.body.directions.flatMap((group) =>
          (Array.isArray(group.listings) ? group.listings : []).flatMap((car) => {
            const row = listingFromCar(car);
            return row ? [row] : [];
          }),
        )
      : [];
    const spec = buildSearchSpec({
      note,
      mode,
      // Never stamp need.distanceMiles as a user form edit — only client constraints
      // with origin "user" may become form overrides (passed via body.constraints).
      formEdits: body?.constraints ? pickUserFormConstraints(body.constraints) : undefined,
      servPlan: {
        ...(body?.findPlan ? findPlanToServHint(body.findPlan) : {}),
        ...(validatedNeed.ok
          ? {
              priceMaxUsd:
                validatedNeed.need.budgetKnown && validatedNeed.need.budgetUsd != null
                  ? validatedNeed.need.budgetUsd
                  : undefined,
              yearMin: validatedNeed.need.yearMin ?? undefined,
              yearMax: validatedNeed.need.yearMax ?? undefined,
              milesMax: validatedNeed.need.milesMax ?? undefined,
              location: { zip: validatedNeed.need.zip },
            }
          : {}),
      },
    });
    const matchFormEdits = body?.constraints ? pickUserFormConstraints(body.constraints) : undefined;
    const runId = await syncRunSafely(kv, {
      runId: typeof body?.runId === "string" ? body.runId : null,
      ownerId: id,
      kind: mode === "flip" ? "resale" : "find",
      note,
      mode,
      spec,
      formEdits: matchFormEdits,
      listings,
      queryCount: providerQueriesUsed,
      creditsCharged: charged ? 1 : 0,
      spendKey: charged ? spendKey : null,
      terminal: listingCount === 0 || planFailed,
      sources: providerQueriesUsed > 0 ? ["cars_for_sale"] : [],
    });
    if (runId) payload.runId = runId;
    if (runId && searchContextToken) {
      const owned = await loadFindSearchContext(kv, { userId: id, token: searchContextToken });
      if (owned.ok) await updateFindSearchContext(kv, owned.record, { runId });
    }
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

    return Response.json({ ...payload, runId }, { status: result.status });
  } finally {
    await releaseInflight();
  }
}
