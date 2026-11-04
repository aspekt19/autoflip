import type { Listing } from "@/domain/types";

export type ListingQuery = {
  make?: string;
  model?: string;
  year?: number;
  zip?: string;
  distanceMiles?: number;
  limit?: number;
};

/**
 * MarketCheck is intentionally disabled.
 * Do not enable this until a written production license exists.
 * The app never calls it.
 */
export class MarketCheckProvider {
  readonly id = "marketcheck";
  readonly enabled = false as const;
  readonly reason =
    "Disabled until a licensed production release. The free tier is evaluation-only and the cache terms do not fit Deal Radar.";

  search(_query: ListingQuery): Promise<Listing[]> {
    return Promise.reject(new Error(this.reason));
  }

  getByVin(_vin: string): Promise<Listing | null> {
    return Promise.reject(new Error(this.reason));
  }
}
