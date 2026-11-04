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
  drivetrain: string | null;
  bodyStyle: string | null;
  latitude: number | null;
  longitude: number | null;
  removedAt: string | null;
  source: ListingSource;
};

export type Mode = "personal" | "flip";

export type Verdict =
  | "good_deal"
  | "fair"
  | "overpriced"
  | "walk_away"
  | "insufficient_data";

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
};

export type VinDecode = {
  year: number | null;
  make: string | null;
  model: string | null;
  errorCode: string | null;
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

export type ComputedReport = {
  mode: Mode;
  subject: Listing;
  verdict: Verdict;
  score: number | null;
  reasons: string[];
  flags: Flag[];
  questions: string[];
  comps: ComparableUsed[];
  compScope: string;
  percentile: number | null;
  fairValueUsd: number | null;
  priceGap: number | null;
  mileage: {
    expectedMiles: number | null;
    subjectMiles: number | null;
    medianCompMiles: number | null;
    perMileUsd: number | null;
  };
  history: HistoryAdjustment;
  recalls: RecallRecord[];
  openParkIt: boolean;
  complaintCount: number | null;
  fuel: FuelFact | null;
  vinDecode: VinDecode | null;
  distanceToSearchZipMiles: number | null;
  flip: FlipMath | null;
  assumptions: Record<string, number>;
  dataNotes: string[];
  sample: boolean;
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
  explanationSource: "serv" | "template";
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
