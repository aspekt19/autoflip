/**
 * Golden-query run shape (docs/STABILIZATION.md §5).
 * The harness observes the real pipeline. SearchSpec / Run land in U1 / U5;
 * until those exist, this is the recorded view those invariants read.
 */

export type Prov = "note" | "form" | "serv" | "default";

export type Hard<T> = { value: T; source: Prov; quote?: string };

export type ObservedSpec = {
  v: 1;
  hash: string;
  mode: "personal" | "flip";
  note: string;
  hard: {
    priceMaxUsd?: Hard<number>;
    yearMin?: Hard<number>;
    yearMax?: Hard<number>;
    milesMax?: Hard<number>;
    zip?: Hard<string | null>;
    radiusMi?: Hard<number | null>;
    drivetrain?: Hard<"awd_4wd">;
    excludeMakes?: Hard<string[]>;
  };
  /** What inventory was actually asked for (direction years, not the confirm draft). */
  enforced: {
    yearMin: number | null;
    yearMax: number | null;
    milesMax: number | null;
    priceMaxUsd: number | null;
    zip: string | null;
    radiusMi: number | null;
  };
};

export type ShownListing = {
  vin: string;
  year: number;
  make: string;
  model: string;
  priceUsd: number | null;
  miles: number | null;
  distanceMiles: number | null;
  drivetrain: string | null;
  /** True when the product explicitly told the buyer this fact is unknown. */
  drivetrainUnknownFlagged: boolean;
  accidentCount: number | null;
  accidentUnknownFlagged: boolean;
  seats: number | null;
  seatsUnknownFlagged: boolean;
  fuel: string | null;
  dealer: string | null;
  vdp: string | null;
  state: string | null;
  reconUsd: number | null;
  estimatedDaysToSell: number | null;
  daysFlagged: boolean;
};

export type StepTiming = {
  name: string;
  elapsedMs: number;
  /** Profile timeout when this step is a SERV profile; null for inventory. */
  profileTimeoutMs: number | null;
  status: "ok" | "failed" | "skipped" | "timeout";
};

export type GoldenFinal = {
  pickVin: string | null;
  verdict: string | null;
  confidence: "High" | "Medium" | "Low" | null;
  budgetUsd: number | null;
  providerQueriesUsed: number;
  listingVins: string[];
};

export type GoldenRun = {
  caseId: string;
  specs: ObservedSpec[];
  listings: ShownListing[];
  providerQueriesUsed: number;
  /** Auto.dev listing URLs the pipeline actually dispatched. */
  listingUrls: string[];
  verdict: string | null;
  confidence: "High" | "Medium" | "Low" | null;
  /** stopped = honest stop, no charge. error = failed without that contract. */
  status: "ok" | "stopped" | "error";
  charged: boolean;
  pickVin: string | null;
  proofRecords: ReadonlyArray<{ specHash?: string; purpose?: string; status?: string; servResponseId?: string | null; reason?: string | null; verdict?: string | null }>;
  buyer: {
    headline: string | null;
    message: string | null;
    nextStep: string | null;
    journal: string[];
  };
  steps: StepTiming[];
  idempotencyKeys: string[];
  replayedPriorDelivery: boolean;
  /** Target the pipeline applied. Null means the user did not set one and none was invented. */
  appliedTargetProfitUsd: number | null;
  towing: "unknown" | "claimed";
  /** Soft fuel preference the plan actually kept. */
  fuelPreference: string | null;
  elapsedMs: number;
  /** True when replay had no recording files for this case. */
  recordingsPending: boolean;
  /** True when replay saw a hash that is not in an existing recording set. */
  unseenRequest: boolean;
  final: GoldenFinal;
  /** Server Run produced from this pipeline result. */
  storedRun?: {
    finalMatchesProgress: boolean;
    verdict: string | null;
    creditsCharged: number;
    permalinkHtml: string;
    /** Public GET /api/run body. The same object the invariant checker reads. */
    publicRun?: unknown;
  };
};

export type CheckFailure = { id: string; message: string };
