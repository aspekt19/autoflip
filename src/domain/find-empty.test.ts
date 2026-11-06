import { describe, expect, it } from "vitest";
import { emptyNeed } from "./need";
import { emptyReasonFromProviderError, findEmptyCopy, statusForFindEmpty } from "./find-empty";

describe("find empty reasons", () => {
  it("maps provider errors without blaming the shopper's filters for config/quota/timeout", () => {
    expect(emptyReasonFromProviderError("listings_unconfigured")).toBe("listings_unconfigured");
    expect(emptyReasonFromProviderError("demo_limit")).toBe("demo_limit");
    expect(emptyReasonFromProviderError("provider_timeout")).toBe("provider_timeout");
    expect(emptyReasonFromProviderError("listings_error")).toBe("provider_failure");
    expect(emptyReasonFromProviderError("invalid_need")).toBe("invalid_need");
    expect(emptyReasonFromProviderError(null)).toBe("unknown");

    const unconfigured = findEmptyCopy("listings_unconfigured");
    expect(unconfigured.detail).toMatch(/no listings API key|not configured/i);
    expect(unconfigured.nextStep).toMatch(/AUTODEV_API_KEY|operator/i);
    expect(unconfigured.nextStep).toMatch(/not the cause/i);
    expect(unconfigured.nextStep).not.toMatch(/widen|raise the mileage/i);
    expect(statusForFindEmpty("listings_unconfigured")).toBe(503);

    const store = findEmptyCopy("shared_store_required");
    expect(store.headline).toMatch(/Shared listings store/i);
    expect(store.nextStep).toMatch(/Upstash/i);
    expect(store.nextStep).not.toMatch(/AUTODEV_API_KEY/i);
    expect(statusForFindEmpty("shared_store_required")).toBe(503);
    expect(emptyReasonFromProviderError("quota_backend_not_distributed")).toBe("shared_store_required");

    const timeout = findEmptyCopy("provider_timeout");
    expect(timeout.nextStep).toMatch(/Retry/i);
    expect(timeout.nextStep).toMatch(/not treat this as proof/i);
    expect(statusForFindEmpty("provider_timeout")).toBe(504);

    const quota = findEmptyCopy("demo_limit");
    expect(quota.nextStep).not.toMatch(/widen|radius|filters/i);
    expect(statusForFindEmpty("demo_limit")).toBe(429);
  });

  it("keeps confirmed empty inventory distinct from no directions and unknown", () => {
    const need = {
      ...emptyNeed("personal"),
      useCase: "family" as const,
      note: "family SUV",
      make: "Mazda",
      preferredMakes: ["Mazda"],
      openToOtherMakes: false,
      zip: "68114",
      distanceMiles: 100,
      budgetKnown: true,
      budgetUsd: 20_000,
    };
    const empty = findEmptyCopy("empty_inventory", need);
    expect(empty.headline).toMatch(/No matching listings/i);
    expect(empty.nextStep).toMatch(/wider radius|nationwide|mileage/i);
    expect(statusForFindEmpty("empty_inventory")).toBe(200);

    const directions = findEmptyCopy("no_directions", need);
    expect(directions.detail).toMatch(/guidance|direction/i);
    expect(directions.nextStep).toMatch(/what the car is for|make and model/i);

    const unknown = findEmptyCopy("unknown");
    expect(unknown.detail).toMatch(/unknown/i);
    expect(unknown.detail).not.toMatch(/nothing in your area/i);
  });

  it("preserves an observed provider message instead of inventing local inventory claims", () => {
    const copy = findEmptyCopy("provider_failure", null, "The listing lookup returned an error.");
    expect(copy.detail).toBe("The listing lookup returned an error.");
    expect(copy.detail).not.toMatch(/nothing in your area/i);
  });
});
