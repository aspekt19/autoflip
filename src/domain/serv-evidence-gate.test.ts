import { describe, expect, it } from "vitest";
import {
  FIND_EVIDENCE_SOURCES,
  RESALE_EVIDENCE_SOURCES,
  buildEvidenceAttemptIndex,
  evaluateEvidenceGate,
  evidenceRepairAlreadySent,
  formatSourcesCheckedLine,
  mmyKey,
} from "./serv-evidence-gate";

const VIN = "1HGCM82633A004352";
const listing = { vin: VIN, year: 2018, make: "Honda", model: "Civic" };

describe("serv evidence gate (attempt-only)", () => {
  it("requires Find sources and Resale adds flip_pnl", () => {
    expect(FIND_EVIDENCE_SOURCES).toEqual([
      "recalls_complaints",
      "safety_ratings",
      "vin_decode",
      "fuel_economy",
      "market_comps",
    ]);
    expect(RESALE_EVIDENCE_SOURCES).toContain("flip_pnl");
  });

  it("indexes attempts by VIN / MMY / make-model; empty+error still cover", () => {
    const index = buildEvidenceAttemptIndex([
      {
        name: "get_vin_decode",
        args: { vins: [VIN] },
        ok: false,
        summary: "get_vin_decode error",
        result: { error: "upstream" },
      },
      {
        name: "get_fuel_economy",
        args: { vins: [VIN] },
        ok: true,
        summary: "empty menu",
        result: { vehicles: [], empty: true },
      },
      {
        name: "get_recalls_complaints",
        args: { year: 2018, make: "Honda", model: "Civic" },
        ok: true,
        result: { recallCount: 0, complaintCount: 0 },
      },
      {
        name: "get_safety_ratings",
        args: { year: 2018, make: "Honda", model: "Civic" },
        ok: true,
        result: { available: false },
      },
      {
        name: "get_market_comps",
        args: { make: "Honda", model: "Civic" },
        ok: true,
        result: { cards: [{ price: 1 }] },
      },
    ]);
    expect(index.bySource.get("vin_decode")?.get(VIN)).toBe("error");
    expect(index.bySource.get("fuel_economy")?.get(VIN)).toBe("empty");
    expect(index.bySource.get("recalls_complaints")?.get(mmyKey(2018, "Honda", "Civic"))).toBe(
      "empty",
    );
    expect(index.bySource.get("safety_ratings")?.get(mmyKey(2018, "Honda", "Civic"))).toBe(
      "unavailable",
    );
    expect(index.bySource.get("market_comps")?.get("honda|civic")).toBe("checked");
  });

  it("first submit without attempts → repair; never blocks on empty/error outcomes", () => {
    const listings = new Map([[VIN, listing]]);
    const coveredJournal = [
      {
        name: "get_vin_decode",
        args: { vins: [VIN] },
        ok: false,
        result: { error: "timeout" },
      },
      {
        name: "get_fuel_economy",
        args: { vins: [VIN] },
        ok: true,
        result: { empty: true, vehicles: [] },
      },
      {
        name: "get_recalls_complaints",
        args: { year: 2018, make: "Honda", model: "Civic" },
        ok: true,
        result: { recallCount: 0 },
      },
      {
        name: "get_safety_ratings",
        args: { year: 2018, make: "Honda", model: "Civic" },
        ok: true,
        result: { available: false },
      },
      {
        name: "get_market_comps",
        args: { make: "Honda", model: "Civic" },
        ok: true,
        result: { cards: [] },
      },
    ];

    const missing = evaluateEvidenceGate({
      picks: [{ vin: VIN }],
      listingsByVin: listings,
      journal: [],
      requiredSources: FIND_EVIDENCE_SOURCES,
      repairAlreadySent: false,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.issues[0]?.message).toMatch(/Evidence gate/i);

    const covered = evaluateEvidenceGate({
      picks: [{ vin: VIN }],
      listingsByVin: listings,
      journal: coveredJournal,
      requiredSources: FIND_EVIDENCE_SOURCES,
      repairAlreadySent: false,
    });
    expect(covered.ok).toBe(true);
    if (!covered.ok) return;
    expect(covered.acceptedWithGaps).toBe(false);
    expect(covered.byVin[VIN]?.every((r) => r.status !== "not_checked")).toBe(true);
  });

  it("after one repair, accept with not_checked (never fail the run)", () => {
    const result = evaluateEvidenceGate({
      picks: [{ vin: VIN }],
      listingsByVin: new Map([[VIN, listing]]),
      journal: [
        {
          name: "get_vin_decode",
          args: { vins: [VIN] },
          ok: true,
          result: { decodes: [{ vin: VIN }] },
        },
      ],
      requiredSources: FIND_EVIDENCE_SOURCES,
      repairAlreadySent: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.acceptedWithGaps).toBe(true);
    expect(result.byVin[VIN]?.find((r) => r.source === "fuel_economy")?.status).toBe(
      "not_checked",
    );
    expect(formatSourcesCheckedLine(result.byVin[VIN] ?? [])).toMatch(/not checked/i);
  });

  it("detects prior evidence repair from journal summary", () => {
    expect(
      evidenceRepairAlreadySent([
        {
          kind: "tool",
          name: "submit_picks",
          ok: false,
          summary: "submit_picks rejected: evidence_incomplete for VIN X",
        },
      ]),
    ).toBe(true);
    expect(
      evidenceRepairAlreadySent([
        { kind: "tool", name: "submit_picks", ok: false, summary: "offer exceeds budget" },
      ]),
    ).toBe(false);
  });

  it("Resale requires flip_pnl attempt", () => {
    const base = [
      {
        name: "get_vin_decode",
        args: { vins: [VIN] },
        ok: true,
        result: { decodes: [{}] },
      },
      {
        name: "get_fuel_economy",
        args: { vins: [VIN] },
        ok: true,
        result: { vehicles: [{}] },
      },
      {
        name: "get_recalls_complaints",
        args: { year: 2018, make: "Honda", model: "Civic" },
        ok: true,
        result: { recallCount: 1 },
      },
      {
        name: "get_safety_ratings",
        args: { year: 2018, make: "Honda", model: "Civic" },
        ok: true,
        result: { available: true },
      },
      {
        name: "get_market_comps",
        args: { make: "Honda", model: "Civic" },
        ok: true,
        result: { cards: [{}] },
      },
    ];
    const withoutPnl = evaluateEvidenceGate({
      picks: [{ vin: VIN }],
      listingsByVin: new Map([[VIN, listing]]),
      journal: base,
      requiredSources: RESALE_EVIDENCE_SOURCES,
      repairAlreadySent: false,
    });
    expect(withoutPnl.ok).toBe(false);

    const withPnl = evaluateEvidenceGate({
      picks: [{ vin: VIN }],
      listingsByVin: new Map([[VIN, listing]]),
      journal: [...base, { name: "get_flip_pnl", args: { vins: [VIN] }, ok: true, result: { cards: [{}] } }],
      requiredSources: RESALE_EVIDENCE_SOURCES,
      repairAlreadySent: false,
    });
    expect(withPnl.ok).toBe(true);
  });
});
