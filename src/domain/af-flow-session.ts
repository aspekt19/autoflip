/**
 * AssistantFlow session restore (af-flow) — versioned migration.
 * Never force sample:true → sample:false (phantom live).
 */

export const AF_FLOW_VERSION = 2;

export type AfFlowListingSource = "autodev" | "sample" | string | null | undefined;

export type AfFlowRestoreInput = {
  v?: number;
  sample?: boolean;
  groups?: Array<{ listings?: Array<{ source?: AfFlowListingSource }> }>;
};

export type AfFlowRestoreDecision =
  | { action: "apply"; sample: boolean; warnUnknownSource: boolean; clearPhantomLive: false }
  | { action: "drop_results"; reason: string; sample: false; clearPhantomLive: true };

export function decideAfFlowRestore(saved: AfFlowRestoreInput): AfFlowRestoreDecision {
  const groups = saved.groups ?? [];
  const sources = groups.flatMap((g) => (g.listings ?? []).map((car) => car.source));
  const hasSampleRows = sources.some((s) => s === "sample");
  const hasUnknownSource = sources.some((s) => s != null && s !== "sample" && s !== "autodev");

  // Legacy (no v / v<2) that claimed live while holding sample rows — drop results.
  if ((saved.v == null || saved.v < AF_FLOW_VERSION) && hasSampleRows && saved.sample === false) {
    return {
      action: "drop_results",
      reason: "Saved search results were cleared because they mixed sample fixtures with a live label.",
      sample: false,
      clearPhantomLive: true,
    };
  }

  const sampleFlag = saved.sample === true || hasSampleRows;
  return {
    action: "apply",
    sample: sampleFlag,
    warnUnknownSource: hasUnknownSource && !sampleFlag,
    clearPhantomLive: false,
  };
}

/** Search-context fields saved with a Find result. Missing token means the loop cannot resume. */
export function resumeFindSearchFromFlow(saved: {
  searchContextToken?: unknown;
  servNextCheckEnabled?: unknown;
}): { searchContextToken: string | null; servNextCheckEnabled: boolean } {
  const token = typeof saved.searchContextToken === "string" ? saved.searchContextToken.trim() : "";
  return {
    searchContextToken: token || null,
    servNextCheckEnabled: Boolean(saved.servNextCheckEnabled) && Boolean(token),
  };
}
