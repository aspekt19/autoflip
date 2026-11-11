import type { StructuredNeed } from "./need";
import { noMatchMessage, searchScopeLabel } from "./need";

/**
 * Why a consumer /find response has no usable cars.
 * Never invent a cause; only use what the observed path supports.
 */
export const FIND_EMPTY_REASONS = [
  "no_directions",
  "empty_inventory",
  "incomplete_search",
  "provider_failure",
  "provider_timeout",
  "listings_unconfigured",
  "shared_store_required",
  "demo_limit",
  "invalid_need",
  "unknown",
] as const;

export type FindEmptyReason = (typeof FIND_EMPTY_REASONS)[number];

/** Per-query outcome for /find — budget_exhausted was never dispatched. */
export type FindQueryOutcomeKind =
  | "ok"
  | "empty"
  | "error"
  | "timeout"
  | "unsupported"
  | "demo_limit"
  | "budget_exhausted";

export type FindEmptyCopy = {
  reason: FindEmptyReason;
  headline: string;
  detail: string;
  nextStep: string;
};

/** Map assembleRadar / match failures onto a consumer-safe empty reason. */
export function emptyReasonFromProviderError(error: string | undefined | null): FindEmptyReason {
  if (error === "listings_unconfigured") return "listings_unconfigured";
  if (error === "quota_backend_not_distributed" || error === "shared_store_required") {
    return "shared_store_required";
  }
  if (error === "demo_limit") return "demo_limit";
  if (error === "timeout" || error === "provider_timeout") return "provider_timeout";
  if (error === "listings_error" || error === "upstream" || error === "provider_failure") return "provider_failure";
  if (error === "invalid_need" || error === "rejected_input" || error === "make_required" || error === "budget_required") {
    return "invalid_need";
  }
  if (!error) return "unknown";
  return "provider_failure";
}

/**
 * Zero visible cars: only claim empty_inventory when ≥1 provider response succeeded
 * (ok or confirmed empty). All timeout / error / demo_limit / unsupported with zero
 * successful responses must NOT look like a confirmed empty market.
 */
export function resolveFindEmptyFromOutcomes(
  outcomes: Array<{ outcome: FindQueryOutcomeKind; message: string | null }>,
  visibleCount: number,
): { reason: FindEmptyReason; hardFail: boolean; observedMessage: string | null } | null {
  if (visibleCount > 0) return null;
  const attempted = outcomes.filter((o) => o.outcome !== "budget_exhausted");
  if (attempted.length === 0) {
    return { reason: "unknown", hardFail: false, observedMessage: null };
  }
  const providerSucceeded = attempted.filter((o) => o.outcome === "ok" || o.outcome === "empty");
  const providerFailed = attempted.filter(
    (o) =>
      o.outcome === "timeout" ||
      o.outcome === "error" ||
      o.outcome === "demo_limit" ||
      o.outcome === "unsupported",
  );
  if (providerSucceeded.length > 0 && providerFailed.length > 0) {
    // Partial coverage — not a confirmed empty market.
    return {
      reason: "incomplete_search",
      hardFail: false,
      observedMessage:
        providerFailed.map((o) => o.message).find(Boolean) ??
        "Some model searches failed or timed out; coverage is incomplete.",
    };
  }
  if (providerSucceeded.length > 0) {
    return {
      reason: "empty_inventory",
      hardFail: false,
      observedMessage: providerSucceeded.find((o) => o.message)?.message ?? null,
    };
  }
  // Zero successful provider responses — never empty_inventory.
  if (attempted.every((o) => o.outcome === "timeout")) {
    return {
      reason: "provider_timeout",
      hardFail: true,
      observedMessage: attempted[0]?.message ?? null,
    };
  }
  if (attempted.some((o) => o.outcome === "demo_limit")) {
    const hit = attempted.find((o) => o.outcome === "demo_limit");
    return { reason: "demo_limit", hardFail: true, observedMessage: hit?.message ?? null };
  }
  if (attempted.some((o) => o.outcome === "unsupported")) {
    const hit = attempted.find((o) => o.outcome === "unsupported");
    return {
      reason: "listings_unconfigured",
      hardFail: true,
      observedMessage: hit?.message ?? null,
    };
  }
  if (attempted.every((o) => o.outcome === "timeout" || o.outcome === "error")) {
    const preferTimeout = attempted.filter((o) => o.outcome === "timeout").length >= attempted.length / 2;
    const hit = attempted.find((o) => o.outcome === (preferTimeout ? "timeout" : "error"));
    return {
      reason: preferTimeout ? "provider_timeout" : "provider_failure",
      hardFail: true,
      observedMessage: hit?.message ?? null,
    };
  }
  return {
    reason: "provider_failure",
    hardFail: true,
    observedMessage: attempted[0]?.message ?? null,
  };
}

export function findEmptyCopy(
  reason: FindEmptyReason,
  need?: Pick<
    StructuredNeed,
    "make" | "preferredMakes" | "milesMax" | "budgetKnown" | "zip" | "distanceMiles" | "note" | "useCase"
  > | null,
  observedMessage?: string | null,
): FindEmptyCopy {
  const scope = need ? searchScopeLabel(need) : "this search";
  switch (reason) {
    case "no_directions": {
      const useAlready = Boolean(need?.useCase && need.useCase !== "unspecified");
      return {
        reason,
        headline: "No search directions yet",
        detail:
          observedMessage?.trim() ||
          "Lemonless does not have a model direction for this note yet. That is missing guidance, not a listing search result. No listing search ran.",
        nextStep: useAlready
          ? "Name a make and model (or a body style with preferred models), then search again. You already chose what the car is for — this was not an empty inventory result."
          : "Choose what the car is for (for example family or commute), or name a make and model, then search again.",
      };
    }
    case "empty_inventory":
      return {
        reason,
        headline: "No matching listings in this live search",
        detail:
          observedMessage?.trim() ||
          (need
            ? noMatchMessage(need)
            : `The live listings provider returned no cars that match these filters in ${scope}.`),
        nextStep: need?.zip && need.distanceMiles != null
          ? "Try a wider radius, switch to nationwide, raise the mileage cap, or loosen the make/model refine."
          : "Try raising the mileage or budget cap, or refine to a different model. This was a confirmed empty provider result, not a connection failure.",
      };
    case "incomplete_search":
      return {
        reason,
        headline: "Incomplete search — coverage unknown for some models",
        detail:
          observedMessage?.trim() ||
          "At least one model search succeeded empty, but other model searches timed out or failed. This is a partial result, not proof the market is empty.",
        nextStep:
          "Retry the search to finish the failed models. Failed lookups are not confirmed empty inventory — changing filters will not fill unknown coverage.",
      };
    case "provider_timeout":
      return {
        reason,
        headline: "Listing search timed out",
        detail:
          observedMessage?.trim() ||
          "The listings provider did not finish in time. No inventory was invented for this page.",
        nextStep: "Retry the search. Do not treat this as proof that nothing matches your filters.",
      };
    case "provider_failure":
      return {
        reason,
        headline: "Listing search unavailable",
        detail:
          observedMessage?.trim() ||
          "The live listings provider returned an error. No inventory was invented for this page.",
        nextStep: "Retry in a moment. This is not a filter or ZIP problem.",
      };
    case "listings_unconfigured":
      return {
        reason,
        headline: "Live listings are not configured",
        detail:
          observedMessage?.trim() ||
          "This environment has no listings API key, so Lemonless cannot show dealer inventory. Sample fixtures are not shown as search results.",
        nextStep: "An operator needs to set AUTODEV_API_KEY for this deployment. Your filters are not the cause.",
      };
    case "shared_store_required":
      return {
        reason,
        headline: "Shared listings store required",
        detail:
          observedMessage?.trim() ||
          "This serverless environment needs a persistent shared store (Upstash) for monthly listing quotas before any live Autodev lookup.",
        nextStep:
          "An operator needs to configure Upstash Redis for this deployment. This is not a missing Auto.dev key and not a filter problem.",
      };
    case "demo_limit":
      return {
        reason,
        headline: "Listing lookup quota reached",
        detail:
          observedMessage?.trim() ||
          "The shared listings quota for this period is used up. No inventory was invented for this page.",
        nextStep: "Retry after the quota resets, or ask an operator to raise the cap. This is not a filter problem.",
      };
    case "invalid_need":
      return {
        reason,
        headline: "That search request is not usable",
        detail: observedMessage?.trim() || "The search inputs could not be validated.",
        nextStep: "Fix the highlighted fields and search again.",
      };
    default:
      return {
        reason: "unknown",
        headline: "No cars to show",
        detail:
          observedMessage?.trim() ||
          "Lemonless could not determine why this search is empty. The cause is unknown.",
        nextStep: "Retry once. If it stays empty, say what you searched so we can inspect the provider response.",
      };
  }
}

/**
 * Whether a Find delivery may debit 1 credit.
 * Only a completed search that ran at least one provider query and returned
 * at least one listing may charge — zero results / no directions never debit.
 */
export function findDeliveryChargesCredit(input: {
  ok: boolean;
  providerQueriesUsed: number;
  listingCount: number;
  emptyReason: string | null | undefined;
}): boolean {
  return (
    input.ok === true &&
    input.providerQueriesUsed > 0 &&
    input.listingCount > 0 &&
    !input.emptyReason
  );
}

/** HTTP status for consumer match failures that must not look like successful empty inventory. */
export function statusForFindEmpty(reason: FindEmptyReason): number {
  switch (reason) {
    case "listings_unconfigured":
    case "shared_store_required":
      return 503;
    case "demo_limit":
      return 429;
    case "provider_timeout":
      return 504;
    case "provider_failure":
      return 502;
    case "invalid_need":
      return 400;
    case "incomplete_search":
    case "empty_inventory":
    case "no_directions":
    case "unknown":
      return 200;
    default:
      return 200;
  }
}
