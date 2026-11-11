/**
 * Merge-gate acceptance: free text → Find SERV parse (response id) → Find
 * verdict_decide (response id) → Watch → radar Check → radar verdict_decide
 * (response id). Fails if any SERV step is missing.
 *
 * CI: npm run test:acceptance:find-radar-serv
 */
import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { demoPresets } from "@/domain/demo-presets";
import {
  assertServStepProof,
  isDecisionProofRecord,
  NEED_PARSE_RUBRIC_ID,
  RADAR_VERDICT_RUBRIC_ID,
  VERDICT_RUBRIC_ID,
} from "@/domain/decision-proof-record";
import { seenStorageKey, type SavedSearch, type WatchAlert } from "@/domain/radar-watch";
import type { BestDealCandidate, BestDealResult } from "@/domain/find-best-deal";
import { understandNeed } from "@/server/understand-need";
import { runFindSettleServ } from "@/server/find-settle-serv";
import { reviewPersonalCandidate } from "@/server/radar-serv";
import { BASE_MODEL } from "@/server/serv";
import { normalizeCriteria } from "@/server/radar-normalize-criteria";
import { listAlerts, listRuns, saveAlerts, saveSearches, seenVins, storeSeenPrices } from "@/server/radar-store";
import { runRadarCycle } from "@/server/radar-cycle";
import { emptyPlans, writePlans } from "@/server/plan-book";
import type { Listing } from "@/domain/types";
import type { AlertNumbers } from "@/domain/radar-watch";
import type { PriceBadge } from "@/domain/price-badge";

const NOTE =
  "Looking for a Toyota RAV4 near Miami under $18,000 with under 80,000 miles for commuting.";

// Provenance: response ids recorded in eval/results/latest.json (live SERV eval run).
// Not invented fixtures — required so proof records can show a real provider id.
const EXTRACT_ID = "chatcmpl-EhAXMUOvyEyLBjo5Y5ePSlTGZUccv";
const GUARD_ID = "chatcmpl-EhAXRHqVvZboG3VbGkd9vHUK17vjX";
const DECIDE_ID = "chatcmpl-EhAXVLvBtSQWSke1cYOqfUhOYjf9W";
const CHALLENGE_ID = "chatcmpl-EhAXZhvJMg9fOjBmfQQFBjbSFfeU4";
const RADAR_GUARD_ID = "chatcmpl-EhAXf1ozyL2jU3cFvQQrZ2wdqWytG";
const RADAR_DECIDE_ID = "chatcmpl-EhAXniAGyHsm7EbcjdxdMPwqjF7je";

function schemaName(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const rf = (body as { response_format?: { json_schema?: { name?: unknown } } }).response_format;
  const name = rf?.json_schema?.name;
  return typeof name === "string" ? name : null;
}

function systemText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> }).messages;
  const system = messages?.find((row) => row.role === "system");
  return typeof system?.content === "string" ? system.content : "";
}

function userText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> }).messages;
  const user = messages?.find((row) => row.role === "user");
  return typeof user?.content === "string" ? user.content : "";
}

function chatCompletion(id: string, content: string): Response {
  return Response.json({
    id,
    object: "chat.completion",
    model: "gpt-test",
    choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function listingsPayload() {
  return {
    data: [14_900, 17_000, 17_500, 18_000].map((price, index) => ({
      vin: ["4T1KZ1AK4MU060006", "4T1K61AK0MU423359", "4T1K61AK4MU610393", "4T1NZ1AK2LU042082"][index],
      vehicle: {
        vin: ["4T1KZ1AK4MU060006", "4T1K61AK0MU423359", "4T1K61AK4MU610393", "4T1NZ1AK2LU042082"][index],
        year: 2016,
        make: "Toyota",
        model: "RAV4",
        bodyStyle: "SUV",
      },
      retailListing: {
        price,
        miles: index === 0 ? 40_000 : 90_000,
        city: "Miami",
        state: "FL",
        zip: "33101",
        used: true,
      },
      history: null,
    })),
  };
}

function candidate(partial: Partial<BestDealCandidate> & Pick<BestDealCandidate, "key">): BestDealCandidate {
  return {
    make: "Toyota",
    model: "RAV4",
    year: 2016,
    priceUsd: 14_900,
    miles: 40_000,
    vin: "4T1KZ1AK4MU060006",
    score: 10,
    factors: [
      {
        id: "price_vs_model_asks",
        label: "Price",
        points: 4,
        detail: "Asking is near the fair value of $17,000 from similar listings.",
        source: "code",
      },
      {
        id: "mmy_recall_campaigns",
        label: "Recalls",
        points: 2,
        detail: "Recall campaigns were checked for this year and model.",
        source: "code",
      },
    ],
    unknowns: [],
    fuelSummary: null,
    excludedFromPick: false,
    excludedReason: null,
    sellerQuestions: [],
    vdp: "https://dealer.example/rav4",
    ...partial,
  };
}

describe("find → SERV → watch → radar verdict_decide acceptance (merge gate)", () => {
  it("keeps a SERV response id through free-text parse, Find settle, Watch, and radar Check", async () => {
    // --- (1) Free text → Find need_guard + need_extract with response id ---
    const findFetch: typeof fetch = async (_input, init) => {
      let body: unknown = null;
      try {
        body = init?.body ? JSON.parse(String(init.body)) : null;
      } catch {
        body = null;
      }
      const schema = schemaName(body);
      const system = systemText(body);
      if (schema === "need_extract") {
        return chatCompletion(
          EXTRACT_ID,
          JSON.stringify({
            useCase: "commute",
            mustHaves: [],
            priorities: ["reliability"],
            budgetUsd: 18_000,
            zip: "33101",
            repairAbility: "unknown",
            targetProfitUsd: null,
            milesMax: 80_000,
            make: "Toyota",
            preferredMakes: ["Toyota"],
            preferredModels: [{ make: "Toyota", model: "RAV4" }],
            bodyStyle: "SUV",
            transmission: null,
            fuelEconomyPriority: false,
            historyPreference: null,
          }),
        );
      }
      if (/shopping for a car/i.test(system)) {
        return chatCompletion(GUARD_ID, "ALLOW");
      }
      return chatCompletion(GUARD_ID, "ALLOW");
    };

    const parsed = await understandNeed(
      { text: NOTE, mode: "personal", budgetUsd: 18_000, budgetKnown: true, zip: "33101" },
      { servKey: "test-key", fetchImpl: findFetch, servModel: BASE_MODEL },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const guard = parsed.checks.find((c) => c.purpose === "need_guard");
    expect(guard, "need_guard check missing — UI would show prompt guard not recorded").toBeTruthy();
    expect(["allow", "passed"]).toContain(guard!.promptGuard);
    expect(parsed.criteriaParse.source).toBe("serv");
    expect(parsed.criteriaParse.responseId).toBe(EXTRACT_ID);
    expect(parsed.criteriaParse.label).toMatch(/response\s+chatcmpl-EhAXMUOvyEyLBjo5Y5ePSlTGZUccv/);
    expect(parsed.proofRecords.every(isDecisionProofRecord)).toBe(true);
    const guardProof = assertServStepProof(parsed.proofRecords, "need_guard");
    expect(guardProof.rubricId).toBe(NEED_PARSE_RUBRIC_ID);
    expect(guardProof.servResponseId).toBe(GUARD_ID);
    const extractProof = assertServStepProof(parsed.proofRecords, "need_extract");
    expect(extractProof.rubricId).toBe(NEED_PARSE_RUBRIC_ID);
    expect(extractProof.servResponseId).toBe(EXTRACT_ID);

    // --- (2) Find top-pick verdict_decide even when evidenceSettled is false ---
    const pick = candidate({ key: "top" });
    const peers = [1, 2, 3].map((n) =>
      candidate({
        key: `p${n}`,
        vin: `4T1KZ1AK4MU06000${n}`,
        priceUsd: 15_000 + n * 100,
        miles: 50_000 + n * 1000,
      }),
    );
    const bestDeal = {
      ranked: [pick, ...peers],
      pick,
      confidence: "medium",
      choice: null,
      why: "test",
      stillUnknown: [],
      sensitivity: [],
      assumptionsNote: "",
      honesty: "",
      evidenceSettled: false,
      settlementNote: "soft evidence still open",
      fairnessHeldOut: [],
      priceProvisional: false,
      allRanked: [pick, ...peers],
      baseline: {
        pick: null,
        cheapest: null,
        lowestMiles: null,
        cheapestIsPick: false,
        lowestMilesIsPick: false,
        cheaperLeftOut: null,
        whyNotCheapest: "",
        factors: [],
        leading: null,
      },
      closeCall: null,
    } as unknown as BestDealResult;

    let findDecideCalls = 0;
    const settleFetch: typeof fetch = async (_input, init) => {
      let body: unknown = null;
      try {
        body = init?.body ? JSON.parse(String(init.body)) : null;
      } catch {
        body = null;
      }
      const schema = schemaName(body);
      if (schema === "find_pick") {
        return chatCompletion(
          "synthetic-test-find-pick-accept",
          JSON.stringify({
            pickKey: pick.key,
            action: "negotiate",
            confidence: "medium",
            note: "Ask of 14900 is near the fair value of 17000.",
            evidenceIds: [`car:${pick.key}`],
          }),
        );
      }
      if (schema === "report_verdict_decision") {
        findDecideCalls += 1;
        return chatCompletion(
          DECIDE_ID,
          JSON.stringify({ verdict: "negotiate", note: "Ask of 14900 is near the fair value of 17000." }),
        );
      }
      if (schema === "report_verdict_challenge") {
        return chatCompletion(
          CHALLENGE_ID,
          JSON.stringify({
            agrees: true,
            action: "negotiate",
            objection: null,
            evidenceIds: ["ev_reason_0"],
          }),
        );
      }
      return chatCompletion("synthetic-test-unused", "ALLOW");
    };

    const settled = await runFindSettleServ({
      bestDeal,
      servKey: "test-key",
      fetchImpl: settleFetch,
      model: "gpt-5.4-mini",
      budgetUsd: 18_000,
      transportPolicy: "experiment_single_attempt",
    });
    expect(settled.ran, "Find settle skipped — verdict_decide never ran").toBe(true);
    expect(findDecideCalls).toBeGreaterThanOrEqual(1);
    const findIds = (settled.agentVerdict?.serv_steps ?? [])
      .map((step) => step.responseId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    expect(findIds.length, "Find agentVerdict trail missing SERV response id").toBeGreaterThan(0);
    expect(settled.proofRecords.every(isDecisionProofRecord)).toBe(true);
    const findDecideProof = assertServStepProof(settled.proofRecords, "verdict_decide");
    expect(findDecideProof.rubricId).toBe(VERDICT_RUBRIC_ID);
    expect(findDecideProof.servResponseId).toBe(DECIDE_ID);
    expect(findDecideProof.clampResult).toBeTruthy();

    // --- (3) Watch stores parse provenance ---
    const kv = new MemoryKv();
    const preset = demoPresets()[0]!;
    const criteria = normalizeCriteria(
      {
        ...preset.criteria,
        freeText: NOTE,
        notes: NOTE,
        criteriaParseSource: "serv",
        criteriaResponseId: parsed.criteriaParse.responseId,
        criteriaOrigin: "find",
        originSearchId: "find-acceptance",
      },
      "personal",
      preset.criteria.radiusMiles ?? 100,
    );
    expect(criteria.criteriaParseSource).toBe("serv");
    expect(criteria.criteriaResponseId).toBe(EXTRACT_ID);

    const search: SavedSearch = {
      ...preset,
      id: "acceptance-rav4",
      preset: false,
      name: "Acceptance RAV4",
      criteria,
      lastCheckedAt: null,
    };
    // Paid-only Radar: fixture watch owner needs an active TEST plan (not a product free grant).
    await writePlans(kv, search.ownerId, {
      ...emptyPlans(),
      planId: "radar",
      personal: { status: "active", lookupKey: "autoflip_radar_monthly", searchLimit: 5 },
      flip: { status: "active", lookupKey: "autoflip_radar_monthly", searchLimit: 5 },
    });
    await saveSearches(kv, [search]);

    // Seed stuck not_reviewed + seen book (root cause c regression).
    const storageKey = seenStorageKey(search.id, search.criteria);
    await storeSeenPrices(kv, storageKey, [{ vin: "4T1KZ1AK4MU060006", priceUsd: 14_900 }]);
    const stuck: WatchAlert = {
      id: "stuck-not-reviewed",
      searchId: search.id,
      ownerId: search.ownerId,
      mode: "personal",
      vin: "4T1KZ1AK4MU060006",
      year: 2016,
      make: "Toyota",
      model: "RAV4",
      trim: null,
      priceUsd: 14_900,
      miles: 40_000,
      city: "Miami",
      state: "FL",
      why: "Not reviewed — SERV verdict_decide did not finish (will retry on next Check).",
      numbers: {
        priceUsd: 14_900,
        fairValueUsd: 17_000,
        priceLabel: "Good price",
        medianUsd: 17_000,
        lowUsd: 16_000,
        highUsd: 18_000,
        gapUsd: 2_100,
        miles: 40_000,
        expectedMiles: 90_000,
        roughMarginUsd: null,
      },
      badge: {
        label: "Good price",
        tone: "good",
        deltaUsd: -2_100,
        deltaLabel: "$2,100 below the fair value of $17,000",
        fairValueUsd: 17_000,
        sampleSize: 3,
        sampleNote: "Compared with 3 similar RAV4 listings.",
      },
      sample: false,
      status: "not_reviewed",
      createdAt: "2026-11-09T12:00:00.000Z",
      priceDropFrom: null,
    };
    await saveAlerts(kv, [stuck]);

    // --- (4) Radar Check → verdict_decide with response id ---
    let radarDecideCalls = 0;
    const radarFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("auto.dev")) {
        return Response.json(listingsPayload());
      }
      let body: unknown = null;
      try {
        body = init?.body ? JSON.parse(String(init.body)) : null;
      } catch {
        body = null;
      }
      const schema = schemaName(body);
      const system = systemText(body);
      const user = userText(body);
      if (schema === "report_verdict_decision") {
        radarDecideCalls += 1;
        return chatCompletion(
          RADAR_DECIDE_ID,
          JSON.stringify({
            verdict: "negotiate",
            note: "Ask of 14900 is near the fair value of 17000.",
          }),
        );
      }
      if (schema === "report_verdict_challenge") {
        return chatCompletion(
          CHALLENGE_ID,
          JSON.stringify({
            agrees: true,
            action: "negotiate",
            objection: null,
            evidenceIds: ["e1", "e2"],
          }),
        );
      }
      if (/vehicle lookup/i.test(system) || /shopping for a car/i.test(system)) {
        return chatCompletion(RADAR_GUARD_ID, "ALLOW");
      }
      if (user.includes("fairValueUsd") || user.includes("allowedActions")) {
        radarDecideCalls += 1;
        return chatCompletion(
          RADAR_DECIDE_ID,
          JSON.stringify({
            verdict: "negotiate",
            note: "Ask of 14900 is near the fair value of 17000.",
          }),
        );
      }
      return chatCompletion(RADAR_GUARD_ID, "ALLOW");
    };

    const run = await runRadarCycle({
      kv,
      now: new Date("2026-11-10T12:00:00Z"),
      trigger: "check_now",
      fetchImpl: radarFetch,
      autodevKey: "test",
      servKey: "test-key",
      servModel: BASE_MODEL,
      origin: "https://autoflip.example",
      env: {},
      forceAll: true,
      timeouts: { serv: 30_000, autodev: 5_000 },
      deadlineMs: 60_000,
    });

    const decideActivity = (run.servActivity ?? []).filter((row) => row.profile === "verdict_decide");
    expect(
      radarDecideCalls >= 1 || decideActivity.length >= 1,
      "radar Check never called verdict_decide",
    ).toBe(true);
    const withId = decideActivity.find((row) => Boolean(row.responseId));
    expect(withId?.responseId, "radar verdict_decide missing response id").toBeTruthy();
    expect(withId?.responseId).toBe(RADAR_DECIDE_ID);

    // Same proof contract as Find — reviewPersonalCandidate must emit a proof record.
    const listing: Listing = {
      vin: "4T1KZ1AK4MU060006",
      year: 2016,
      make: "Toyota",
      model: "RAV4",
      trim: null,
      priceUsd: 14_900,
      miles: 40_000,
      city: "Miami",
      state: "FL",
      zip: "33101",
      dealer: null,
      vdp: null,
      primaryImage: null,
      carfaxUrl: null,
      used: true,
      cpo: null,
      accidentCount: null,
      oneOwner: null,
      ownerCount: null,
      usageType: null,
      fuel: null,
      engine: null,
      drivetrain: null,
      bodyStyle: "SUV",
      latitude: null,
      longitude: null,
      removedAt: null,
      source: "autodev",
    };
    const numbers: AlertNumbers = {
      priceUsd: 14_900,
      fairValueUsd: 17_000,
      priceLabel: "Good price",
      medianUsd: 17_000,
      lowUsd: 16_000,
      highUsd: 18_000,
      gapUsd: 2_100,
      miles: 40_000,
      expectedMiles: 90_000,
      roughMarginUsd: null,
    };
    const badge: PriceBadge = {
      label: "Good price",
      tone: "good",
      deltaUsd: -2_100,
      deltaLabel: "$2,100 below the fair value of $17,000",
      fairValueUsd: 17_000,
      sampleSize: 3,
      sampleNote: "Compared with 3 similar RAV4 listings.",
    };
    const radarReview = await reviewPersonalCandidate(
      { listing, numbers, badge, baseWhy: "Good price vs similar RAV4s.", budgetUsd: 18_000 },
      {
        fetchImpl: radarFetch,
        servKey: "test-key",
        servModel: BASE_MODEL,
        timeoutMs: 8_000,
        searchId: search.id,
        challenge: false,
        nowIso: "2026-11-10T12:00:00.000Z",
      },
      [],
    );
    expect(radarReview.proofRecords.every(isDecisionProofRecord)).toBe(true);
    const radarDecideProof = assertServStepProof(radarReview.proofRecords, "verdict_decide");
    expect(radarDecideProof.rubricId).toBe(RADAR_VERDICT_RUBRIC_ID);
    expect(radarDecideProof.servResponseId).toBe(RADAR_DECIDE_ID);

    const alerts = await listAlerts(kv);
    const stillStuckOnly =
      alerts.length > 0 && alerts.every((row) => row.searchId === search.id && row.status === "not_reviewed");
    const seen = await seenVins(kv, storageKey);
    expect(
      stillStuckOnly && !seen.has("4T1KZ1AK4MU060006"),
      "stuck not_reviewed VIN was not re-reviewed after Check",
    ).toBe(false);

    expect((await listRuns(kv)).some((item) => item.id === run.id)).toBe(true);
  });
});
