import type { StructuredNeed } from "./need";
import { noMatchMessage, searchScopeLabel } from "./need";

/**
 * Why a consumer /find response has no usable cars.
 * Never invent a cause; only use what the observed path supports.
 */
export const FIND_EMPTY_REASONS = [
  "no_directions",
  "empty_inventory",
  "provider_failure",
  "provider_timeout",
  "listings_unconfigured",
  "demo_limit",
  "invalid_need",
  "unknown",
] as const;

export type FindEmptyReason = (typeof FIND_EMPTY_REASONS)[number];

export type FindEmptyCopy = {
  reason: FindEmptyReason;
  headline: string;
  detail: string;
  nextStep: string;
};

/** Map assembleRadar / match failures onto a consumer-safe empty reason. */
export function emptyReasonFromProviderError(error: string | undefined | null): FindEmptyReason {
  if (error === "listings_unconfigured") return "listings_unconfigured";
  if (error === "demo_limit") return "demo_limit";
  if (error === "timeout" || error === "provider_timeout") return "provider_timeout";
  if (error === "listings_error" || error === "upstream" || error === "provider_failure") return "provider_failure";
  if (error === "invalid_need" || error === "rejected_input" || error === "make_required" || error === "budget_required") {
    return "invalid_need";
  }
  if (!error) return "unknown";
  return "provider_failure";
}

export function findEmptyCopy(
  reason: FindEmptyReason,
  need?: Pick<StructuredNeed, "make" | "preferredMakes" | "milesMax" | "budgetKnown" | "zip" | "distanceMiles" | "note"> | null,
  observedMessage?: string | null,
): FindEmptyCopy {
  const scope = need ? searchScopeLabel(need) : "this search";
  switch (reason) {
    case "no_directions":
      return {
        reason,
        headline: "No search directions yet",
        detail:
          observedMessage?.trim() ||
          "Lemonless does not have a model direction for this note yet. That is missing guidance, not a listing search result.",
        nextStep: "Choose what the car is for (for example family or commute), or name a make and model, then search again.",
      };
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

/** HTTP status for consumer match failures that must not look like successful empty inventory. */
export function statusForFindEmpty(reason: FindEmptyReason): number {
  switch (reason) {
    case "listings_unconfigured":
      return 503;
    case "demo_limit":
      return 429;
    case "provider_timeout":
      return 504;
    case "provider_failure":
      return 502;
    case "invalid_need":
      return 400;
    default:
      return 200;
  }
}
