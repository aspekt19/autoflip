import { describe, expect, it } from "vitest";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import fixture from "../../fixtures/autodev-camry.json";
import { proposeDirections } from "./directions";
import { explicitNeedFromText, validateNeed } from "./need";
import { emptyReasonFromProviderError, findEmptyCopy } from "./find-empty";
import { assembleRadar } from "@/server/assemble";

const OWNER_NOTE =
  "I'm looking for a reliable used SUV for around $20,000. Mostly for everyday driving, but I also take longer trips with my family. I'd prefer something comfortable, not too expensive to maintain, and ideally with AWD. I like the Mazda CX-5 and Toyota RAV4, but I'm open to other options. I don't want to buy a car with hidden problems.";

describe("consumer /find live-only inventory contract", () => {
  it("never treats sample fixtures as a successful consumer radar result", async () => {
    const missing = await assembleRadar({ make: "Mazda", model: "CX-5", mode: "personal" }, {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toBe("listings_unconfigured");
      expect(emptyReasonFromProviderError(missing.error)).toBe("listings_unconfigured");
      expect(findEmptyCopy("listings_unconfigured").nextStep).toMatch(/not the cause/i);
    }
  });

  it("returns live autodev rows when a key and provider response are present", async () => {
    const result = await assembleRadar(
      { make: "Toyota", model: "Camry", mode: "personal" },
      {
        autodevKey: "test-key",
        autodev: { cache: new TtlCache(), counter: new MemoryCounter() },
        fetch: async () =>
          new Response(JSON.stringify(fixture), { status: 200, headers: { "Content-Type": "application/json" } }),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample).toBe(false);
    expect(result.listings.length).toBeGreaterThan(0);
    expect(result.listings.every((item) => item.source === "autodev")).toBe(true);
  });

  it("keeps owner multi-make directions even when inventory must come from live calls", () => {
    const parsed = validateNeed({
      ...explicitNeedFromText(OWNER_NOTE, "personal"),
      zip: null,
      distanceMiles: null,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const directions = proposeDirections(parsed.need, undefined, new Date("2026-11-06T00:00:00Z"));
    expect(directions[0]?.models).toEqual([
      { make: "Mazda", model: "CX-5" },
      { make: "Toyota", model: "RAV4" },
    ]);
    expect(directions.length).toBeGreaterThan(0);
  });

  it("distinguishes true zero inventory copy from provider failure copy", () => {
    const need = validateNeed({
      ...explicitNeedFromText(OWNER_NOTE, "personal"),
      zip: "68114",
      distanceMiles: 100,
    });
    expect(need.ok).toBe(true);
    if (!need.ok) return;
    const zero = findEmptyCopy("empty_inventory", need.need);
    const fail = findEmptyCopy("provider_failure", need.need, "The listing lookup returned an error.");
    expect(zero.nextStep).toMatch(/radius|nationwide|mileage|budget/i);
    expect(fail.nextStep).toMatch(/Retry/i);
    expect(fail.nextStep).not.toMatch(/widen the radius/i);
  });
});
