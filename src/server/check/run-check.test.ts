import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCheck } from "./run-check";

const FIXTURES = join(process.cwd(), "fixtures/listing-pages");

function govFetch(url: string): Response {
  if (url.includes("DecodeVinValues")) {
    return new Response(
      JSON.stringify({
        Results: [
          {
            ErrorCode: "0",
            ModelYear: "2021",
            Make: "TOYOTA",
            Model: "Camry",
            Trim: "SE",
          },
        ],
      }),
      { status: 200 },
    );
  }
  if (url.includes("recallsByVehicle") || url.includes("complaintsByVehicle")) {
    return new Response(JSON.stringify({ results: [], count: 0 }), { status: 200 });
  }
  if (url.includes("SafetyRatings")) {
    return new Response(JSON.stringify({ Results: [] }), { status: 200 });
  }
  if (url.includes("fueleconomy") || url.includes("fuel")) {
    return new Response(JSON.stringify({ menuItem: [] }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}

describe("runCheck listing paste (no paid Autodev/SERV)", () => {
  it("builds a listing verdict from the dealer fixture HTML text", async () => {
    const html = readFileSync(join(FIXTURES, "dealer-jsonld.html"), "utf8");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.auto.dev") || url.includes("auto.dev")) {
        return new Response(JSON.stringify({ data: [] }), { status: 404 });
      }
      return govFetch(url);
    });

    const result = await runCheck(
      { kind: "paste", text: html, url: "https://dealer.example/camry" },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.kind).toBe("listing");
    expect(result.result.vin).toBe("4T1KZ1AK4MU060006");
    expect(result.result.title).toMatch(/2021 Toyota Camry/);
    expect(result.result.confidence).toMatch(/High|Medium|Low/);
    expect(result.result.provenance.some((row) => row.field === "priceUsd" && row.value === 23990)).toBe(true);
    expect(result.result.unknown.length).toBeGreaterThan(0);
  });

  it("builds a VIN dossier without ask/miles/ZIP", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => govFetch(String(input)));
    const result = await runCheck(
      { kind: "vin", vin: "4T1KZ1AK4MU060006" },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.kind).toBe("vin_dossier");
    expect(result.result.verdict).toBe("dossier");
    expect(result.result.vin).toBe("4T1KZ1AK4MU060006");
    expect(result.result.unknown.some((line) => /asking price/i.test(line))).toBe(true);
  });
});
