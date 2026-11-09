import { describe, expect, it } from "vitest";
import { evaluateResaleDeal } from "./resale-evaluate";

describe("evaluateResaleDeal", () => {
  it("rejects invalid year without calling Autodev", async () => {
    const result = await evaluateResaleDeal(
      {
        year: 1900,
        make: "Toyota",
        model: "Camry",
        miles: 40_000,
        askingUsd: 18_000,
      },
      { autodevKey: "test", autodev: { cache: {} as never, counter: {} as never } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("invalid_year");
  });

  it("reports listings unconfigured when Autodev key is missing", async () => {
    const result = await evaluateResaleDeal({
      year: 2020,
      make: "Toyota",
      model: "Camry",
      miles: 40_000,
      askingUsd: 18_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("listings_unconfigured");
    expect(result.message).toMatch(/not configured/i);
  });
});
