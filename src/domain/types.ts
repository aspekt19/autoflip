import type { DecisionProof } from "./decision-note";

export type ListingSource = "autodev" | "sample";

export type Listing = {
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  miles: number | null;
  priceUsd: number | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  dealer: string | null;
  vdp: string | null;
  /** Dealer or listing page when the feed has one besides the history-report URL. */
  dealerUrl?: string | null;
  primaryImage: string | null;
  carfaxUrl: string | null;
  used: boolean | null;
  cpo: boolean | null;
  accidentCount: number | null;
  oneOwner: boolean | null;
  ownerCount: number | null;
  usageType: string | null;
  fuel: string | null;
  engine: string | null;
  /** Feed transmission when present (Automatic, Manual, CVT, …). Missing is unknown. */
  transmission?: string | null;
  drivetrain: string | null;
  /** Hard all-wheel drive was requested and this listing did not publish a drivetrain we could confirm. */
  drivetrainUnverified?: boolean;
  bodyStyle: string | null;
  /** Dealer body description when it differs from bodyStyle, such as "Sedan" next to "Car". */
  style?: string | null;
  /** Miles from the search ZIP when the listings payload includes it. */
  distanceMiles?: number | null;
  latitude: number | null;
  longitude: number | null;
  removedAt: string | null;
  /** When the listing was first seen by the provider, if that field was present. */
  createdAt?: string | null;
  /** Title brand when the feed states one (salvage, flood). Missing means unknown, not clean. */
  titleBrand?: string | null;
  source: ListingSource;
  /**
   * What priceUsd represents when known (purchase ask vs dealer fee vs unknown).
   * Auto.dev feed alone never invents this — leave unset/unknown. Seller-page
   * labeled closing/doc fees must not qualify as purchase-price evidence.
   */
  askingPriceKind?: "purchase_ask" | "dealer_fee" | "unknown" | null;
  /** Provenance of the figure / label — feed_only until seller-page labeled. */
  askingPriceProvenance?: "feed_only" | "seller_page_labeled" | "missing" | null;
  /** Seller-page label when known (e.g. "Closing Fee"). */
  askingPriceLabel?: string | null;
  /**
   * Seller-page access outcome when a public check ran offline/mapped.
   * unavailable ≠ proof listing gone; not_attempted is the live default.
   */
  askingPriceSellerPageAccess?: "obtained" | "unavailable" | "not_attempted" | null;
};

export type Mode = "personal" | "flip";

export type Verdict =
  | "good_deal"
  | "fair"
  | "overpriced"
  | "walk_away"
  | "insufficient_data"
  | "withheld";

/** Shopper-facing action chosen by SERV under TS guardrails. See decision-action.ts. */
export type { DecisionAction } from "./decision-action";

export type RecallRecord = {
  campaignNumber: string;
  component: string;
  summary: string;
  consequence: string;
  remedy: string;
  parkIt: boolean;
  parkOutSide: boolean;
};

export type FuelFact = {
  source: "fueleconomy.gov";
  match: "closest_config" | "range";
  combMpg: number | null;
  annualFuelCostUsd: number | null;
  annualFuelCostLowUsd: number | null;
  annualFuelCostHighUsd: number | null;
  vehicleClass: string | null;
  configsConsidered: number;
  /**
   * How annualFuelCost* dollars were produced.
   * - epa_published: FuelEconomy fuelCost08 (or legacy equivalent)
   * - labeled_estimate: Find mix × published/fallback $/gal (or EPA annual for electricity)
   * Omit / undefined treated as epa_published for older callers.
   */
  costBasis?: "epa_published" | "labeled_estimate";
};

export type VinDecode = {
  year: number | null;
  make: string | null;
  model: string | null;
  /** vPIC ErrorCode — HTTP 200 alone is not success; inspect this field. */
  errorCode: string | null;
  /** vPIC ErrorText when present (e.g. "6 - Incomplete VIN"). */
  errorText?: string | null;
  /** Extra spec fields from the same DecodeVinValues payload. Missing means not published. */
  trim?: string | null;
  driveType?: string | null;
  engine?: string | null;
  fuel?: string | null;
  /** NHTSA BodyClass. Missing means the decode did not publish one. */
  bodyClass?: string | null;
};

export type Flag = {
  level: "stop" | "caution" | "note";
  text: string;
  source: string;
};

export type ComparableUsed = {
  vin: string;
  year: number;
  trim: string | null;
  miles: number;
  priceUsd: number;
  adjustedPriceUsd: number;
  city: string | null;
  state: string | null;
  distanceMiles: number | null;
  /** Dealer listing URL when the feed included one. */
  sourceUrl?: string | null;
  /** Listing provider label shown to the shopper. */
  sourceLabel?: string | null;
  /** When Lemonless fetched or loaded this row for the report. */
  fetchedAt?: string | null;
  /** Plain-English reasons the asking price was moved toward this car. */
  adjustmentNotes?: string[];
  accidentCount?: number | null;
  usageType?: string | null;
  cpo?: boolean | null;
  oneOwner?: boolean | null;
  ownerCount?: number | null;
};

export type HistoryAdjustment = {
  multiplier: number;
  lines: string[];
};

export type FlipMath = {
  resaleLowUsd: number;
  resaleMidUsd: number;
  resaleHighUsd: number;
  titleFeeUsd: number;
  reconUsd: number;
  sellFriction: number;
  allInUsd: number;
  conservativeProceedsUsd: number;
  marginUsd: number;
  targetBuyUsd: number;
  timeToSellRisk: "low" | "medium" | "high";
  timeToSellNote: string;
};

export type SourceCheckStatus = "available" | "partial" | "unavailable" | "not_checked" | "sample" | "not_connected";

export type SourceCheck = {
  source: string;
  status: SourceCheckStatus;
  detail: string;
  /** When Lemonless made the request. Null when data came from a fixture, is not connected, or provider freshness is not exposed. */
  checkedAt: string | null;
};

export type ComputedReport = {
  mode: Mode;
  subject: Listing;
  verdict: Verdict;
  score: number | null;
  reasons: string[];
  flags: Flag[];
  questions: string[];
  comps: ComparableUsed[];
  /**
   * Adjusted similar-listing count that produced fairValueUsd (badge sampleSize).
   * Prefer this over comps.length for SERV notes — comps may be truncated for display.
   */
  compSampleSize?: number | null;
  compScope: string;
  percentile: number | null;
  fairValueUsd: number | null;
  /** Low end of the middle half of adjusted asking prices. Omitted on older reports. */
  fairRangeLowUsd?: number | null;
  /** High end of the middle half of adjusted asking prices. Omitted on older reports. */
  fairRangeHighUsd?: number | null;
  /** How much to trust the adjusted range. Omitted on older reports. */
  fairConfidence?: "reasonable" | "rough" | "not_available" | null;
  /** How mileage, year, and trim were adjusted. Omitted on older reports. */
  compMethodNote?: string | null;
  priceGap: number | null;
  mileage: {
    expectedMiles: number | null;
    subjectMiles: number | null;
    medianCompMiles: number | null;
    perMileUsd: number | null;
  };
  history: HistoryAdjustment;
  recalls: RecallRecord[];
  /** False when NHTSA did not return a usable recall result; an empty array alone is not enough. */
  recallsAvailable: boolean;
  /** Per-source evidence. Optional so older saved reports remain readable. */
  sourceChecks?: SourceCheck[];
  /**
   * True only when an NHTSA model-year campaign has parkIt=true.
   * Distinct from parkOutside — never set from parkOutSide alone.
   * Model/campaign coverage only; not VIN-affected or unrepaired proof.
   */
  openParkIt: boolean;
  /**
   * True when an NHTSA model-year campaign has parkOutSide=true.
   * Outdoor-parking guidance — not a do-not-drive / hardSafetyStop by itself.
   * Optional so older saved reports remain readable.
   */
  openParkOutside?: boolean;
  complaintCount: number | null;
  fuel: FuelFact | null;
  vinDecode: VinDecode | null;
  distanceToSearchZipMiles: number | null;
  flip: FlipMath | null;
  assumptions: Record<string, number>;
  dataNotes: string[];
  sample: boolean;
  /**
   * SERV-chosen shopper action after TS guardrail clamp.
   * Optional so older saved reports remain readable.
   */
  decision?: {
    action: import("./decision-action").DecisionAction;
    source: "serv" | "deterministic_fallback" | "guardrail_clamp" | "no_serv_key" | "gates_withheld";
    servChoice: import("./decision-action").DecisionAction | null;
    deterministicAction: import("./decision-action").DecisionAction;
    overrideReasons: string[];
    labeledFallback: boolean;
    note: string | null;
    withholdReason?: string | null;
    gates?: Array<{ id: string; status: string; reason: string }>;
  };
  /** Shopper mandate used by ordered gates (budget / profit / repair). */
  mandate?: {
    budgetUsd: number | null;
    budgetKnown: boolean;
    targetProfitUsd: number | null;
    repairAbility: "none" | "minor" | "major" | "unknown";
  };
  /**
   * Documented agent verdict trail (schema lemonless.agent_verdict.v1).
   * Optional so older saved reports remain readable.
   */
  agentVerdict?: import("./agent-verdict-schema").AgentVerdict;
};

export type ProofStep = {
  id: string;
  status: string;
  detail?: string;
};

export type Proof = {
  version: "autoflip.proof.v1";
  inputsHash: string;
  model: string | null;
  promptVersion: string;
  steps: ProofStep[];
  toolOutputs: Record<string, unknown>;
  explanationSource: "serv" | "template" | "unavailable";
  servChecks?: DecisionProof[];
  shadow: {
    requested: boolean;
    hint: string;
    maxIterations: number;
    outcome: string;
  };
};

export type FullReport = {
  id: string;
  createdAt: string;
  explanation: string;
  computed: ComputedReport;
  proof: Proof;
};
