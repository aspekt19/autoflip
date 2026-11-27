import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StructuredNeed } from "@/domain/need";
import { emptyBestDealFromListings } from "../../test/golden/empty-best-deal";
import type { ShownListing } from "../../test/golden/types";
import { buildFindDecideFacts } from "./find-decide-serv";
import {
  FIND_DECIDE_GRAPH_INPUT_SCHEMA_V3,
  findDecideGraphInputVersion,
  findDecideGraphMaxCars,
  prepareFindDecideGraphRun,
  resolveFindDecideGraphSlots,
  FIND_DECIDE_GRAPH_INPUT_SCHEMA,
  buildFindDecideGraphInput,
  validateFindDecideGraphInput,
} from "./find-decide-graph-input";

const A = "1HGCV1F30LA000001";
const B = "4T1B11HK5KU000002";
const listings = [
  { vin: A, year: 2020, make: "Honda", model: "Accord", priceUsd: 21000, miles: 40000, drivetrain: "AWD", fuel: "Gasoline", accidentCount: 0, dealer: null, vdp: null, state: "TX", distanceMiles: 10 },
  { vin: B, year: 2019, make: "Toyota", model: "Camry", priceUsd: null, miles: null, drivetrain: null, fuel: null, accidentCount: null, dealer: null, vdp: null, state: "TX", distanceMiles: 15 },
] as unknown as ShownListing[];
const need = {
  mode: "personal",
  note: "reliable sedan under 22k",
  budgetUsd: 22000,
  budgetKnown: true,
  yearMin: 2018,
  yearMax: null,
  milesMax: 60000,
  mustHaves: ["AWD"],
  priorities: [],
  awdPreference: true,
} as unknown as StructuredNeed;

function build() {
  const best = emptyBestDealFromListings(need, listings);
  const { factSheet, allowedEvidenceIds, guardrailRules } = buildFindDecideFacts({
    peers: best.ranked,
    receipts: [],
    marketPool: [],
  });
  return {
    allowedEvidenceIds,
    guardrailRules,
    input: buildFindDecideGraphInput({
      need,
      factSheet,
      shortlistKeys: best.ranked.map((r) => r.key),
      allowedEvidenceIds,
      codeRankedKey: A,
      guardrailRules,
    }),
  };
}

describe("Find decide graph input", () => {
  it("matches the console schema exactly", () => {
    const docSchema = JSON.parse(
      readFileSync(resolve(__dirname, "serv/find-decide-graph-input.schema.json"), "utf8"),
    );
    expect(FIND_DECIDE_GRAPH_INPUT_SCHEMA).toEqual(docSchema);
    const { input } = build();
    expect(validateFindDecideGraphInput(input)).toEqual([]);
    expect(Object.keys(input).sort()).toEqual(
      ["cars", "evidence_records", "permitted_car_keys", "shopper_requirements"],
    );
  });

  it("formats numbers as text, keeps unknowns null, and gives every evidence id string content", () => {
    const { input, allowedEvidenceIds, guardrailRules } = build();
    const a = input.cars.find((c) => c.key === A)!;
    expect(a.asking_price).toBe("$21,000");
    expect(a.miles).toBe("40,000");
    expect(a.drivetrain).toBe("AWD");
    expect(a.reported_accidents).toBe("0");
    const b = input.cars.find((c) => c.key === B)!;
    expect(b.asking_price).toBeNull();
    expect(b.miles).toBeNull();
    expect(b.drivetrain).toBeNull();
    expect(b.reported_accidents).toBeNull();
    expect(input.evidence_records.map((r) => r.id).sort()).toEqual([...allowedEvidenceIds].sort());
    expect(input.evidence_records.every((r) => typeof r.content === "string" && r.content.length > 0)).toBe(true);
    // Code-ranked key and guardrail rules are carried as data, not dropped.
    expect(input.shopper_requirements).toContain(A);
    expect(input.shopper_requirements).toContain(guardrailRules[0]!);
    expect(input.shopper_requirements).toContain("Needs all-wheel drive: yes");
  });

  it("reports schema violations", () => {
    expect(validateFindDecideGraphInput({ facts: {} })).toEqual(
      expect.arrayContaining(["shopper_requirements: missing", "facts: not allowed"]),
    );
    const { input } = build();
    const bad = { ...input, evidence_records: [{ id: "x", content: { a: 1 } }] };
    expect(validateFindDecideGraphInput(bad)).toContain("evidence_records.0.content: must be string");
    const badCar = { ...input, cars: [{ ...input.cars[0]!, similar_cars_compared: 2.5 }] };
    expect(validateFindDecideGraphInput(badCar)).toContain("cars.0.similar_cars_compared: must be integer or null");
  });

  it("v3: numbers stay numbers, unique slots, schema-valid, versioned by graph id", () => {
    expect(findDecideGraphInputVersion("gr_3d039bd8de63381a", {})).toBe("v2");
    expect(findDecideGraphInputVersion("gr_28beee6b8bffe5a9", {})).toBe("v3");
    expect(findDecideGraphInputVersion("gr_new", { SERV_GRAPH_FIND_DECIDE_INPUT: "v2" })).toBe("v2");
    expect(findDecideGraphMaxCars("v3")).toBe(5);
    const docSchema = JSON.parse(
      readFileSync(resolve(__dirname, "serv/find-decide-graph-input-v3.schema.json"), "utf8"),
    );
    expect(FIND_DECIDE_GRAPH_INPUT_SCHEMA_V3).toEqual(docSchema);
    const best = emptyBestDealFromListings(need, listings);
    const facts = buildFindDecideFacts({ peers: best.ranked, receipts: [], marketPool: [] });
    const run = prepareFindDecideGraphRun(
      "gr_28beee6b8bffe5a9",
      { need, factSheet: facts.factSheet, shortlistKeys: best.ranked.map((r) => r.key), allowedEvidenceIds: facts.allowedEvidenceIds, codeRankedKey: null, guardrailRules: facts.guardrailRules },
      {},
    );
    expect(run.version).toBe("v3");
    expect(run.errors).toEqual([]);
    const cars = (run.input as { cars: Array<Record<string, unknown>> }).cars;
    const a = cars.find((c) => c.key === A)!;
    expect(a.asking_price).toBe(21000);
    expect(a.miles).toBe(40000);
    expect(Array.isArray(a.open_recalls)).toBe(true);
    const b = cars.find((c) => c.key === B)!;
    expect(b.asking_price).toBeNull();
    expect(new Set(cars.map((c) => c.slot)).size).toBe(cars.length);
    expect(run.slotToKey.get(String(a.slot))).toBe(A);
  });

  it("resolves slot picks from our own map and refuses unknown slots", () => {
    const map = new Map([["car_1", A], ["car_2", B]]);
    const payload = { decide: { pickKey: "car_2", confidenceWhy: "car_2 is cheaper", reasons: [{ text: "car_2 asks less", evidenceIds: [] }] }, challenge: { agree: true, issues: [] } };
    const out = resolveFindDecideGraphSlots(payload, map)!;
    expect((out.decide as { pickKey: string }).pickKey).toBe(B);
    expect((out.decide as { reasons: Array<{ text: string }> }).reasons[0]!.text).toBe(`${B} asks less`);
    expect(resolveFindDecideGraphSlots({ ...payload, decide: { pickKey: "car_4" } }, map)).toBeNull();
    expect((resolveFindDecideGraphSlots({ ...payload, decide: { pickKey: A } }, map)!.decide as { pickKey: string }).pickKey).toBe(A);
  });
});
