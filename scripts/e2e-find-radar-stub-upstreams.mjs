#!/usr/bin/env node
/**
 * STUB upstreams for Find/Radar HTTP acceptance (CI / local).
 * Clearly labelled fixture responses — never treat as live Auto.dev or SERV results.
 *
 * Serves:
 *   GET/POST /listings*          → Auto.dev-shaped inventory (STUB)
 *   GET /zip/{zip}               → Auto.dev-shaped ZIP geocode (STUB)
 *   POST /v1/chat/completions    → SERV-shaped chat completions (STUB)
 *   POST /v1/responses           → SERV responses endpoint (STUB)
 *
 * Env: PORT (default 8791)
 */
import http from "node:http";
import { pathToFileURL } from "node:url";

// Response ids below are recorded live SERV completions from eval/results/latest.json
// (reuse for stub provenance only — not a new live call). Never invent chatcmpl-* fixtures.
const PORT = Number(process.env.PORT || 8791);

// VINs must ErrorCode=0 decode as Toyota RAV4 for the listed year. Old Camry VINs
// made free_car_consistency exclude every card after parallel free-gov triage.
const STUB_RAV4_VINS = [
  "2T3N1RFV6MC246998",
  "2T3N1RFV8MC246100",
  "2T3N1RFV4MC250001",
  "2T3N1RFV6MC250002",
];
/** Zip centroids so distance filters can drop cars outside the radius. */
const ZIP_LAT_LON = {
  "33101": [25.7617, -80.1918],
  // City table resolves "near Miami" to 33130, a few miles from the 33101 stub cars.
  "33130": [25.765, -80.23],
  "10001": [40.7506, -73.9971],
  "60601": [41.8863, -87.6181],
  "98101": [47.6101, -122.3344],
};

function haversineMiles(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function stubCar(input) {
  const coords = ZIP_LAT_LON[input.zip] ?? ZIP_LAT_LON["10001"];
  return {
    vin: input.vin,
    vehicle: {
      vin: input.vin,
      year: input.year,
      make: input.make,
      model: input.model,
      bodyStyle: input.bodyStyle,
      drivetrain: input.drivetrain ?? null,
      fuel: input.fuel ?? null,
    },
    retailListing: {
      price: input.price,
      miles: input.miles,
      city: input.city,
      state: input.state,
      zip: input.zip,
      used: true,
      vdp: input.vdp,
    },
    location: [coords[1], coords[0]],
    history: input.accidents == null ? null : { accidentCount: input.accidents },
  };
}

/**
 * Diverse catalogue. The four Miami RAV4s stay inside the Find/Radar e2e query.
 * The rest exist so a filter that is ignored would leak the wrong car.
 */
const STUB_CATALOG = [
  ...[14_900, 17_000, 17_500, 18_000].map((price, index) =>
    stubCar({
      vin: STUB_RAV4_VINS[index],
      year: 2021,
      make: "Toyota",
      model: "RAV4",
      bodyStyle: "SUV",
      drivetrain: "AWD",
      price,
      miles: 40_000 + index * 8_000,
      city: "Miami",
      state: "FL",
      zip: "33101",
      vdp: `https://stub.example/listing/${index}`,
    }),
  ),
  stubCar({
    vin: "1FTEW1EP5JFA00001",
    year: 2012,
    make: "Ford",
    model: "F-150",
    bodyStyle: "Truck",
    drivetrain: "4WD",
    price: 18_000,
    miles: 140_000,
    city: "New York",
    state: "NY",
    zip: "10001",
    vdp: "https://stub.example/listing/f150-2012",
  }),
  stubCar({
    vin: "1FTEW1EP5JFA00002",
    year: 2018,
    make: "Ford",
    model: "F-150",
    bodyStyle: "Truck",
    drivetrain: "4WD",
    price: 28_000,
    miles: 60_000,
    city: "New York",
    state: "NY",
    zip: "10001",
    vdp: "https://stub.example/listing/f150-2018",
  }),
  stubCar({
    vin: "2HGFC2F59GH000003",
    year: 2016,
    make: "Honda",
    model: "Civic",
    bodyStyle: "Sedan",
    price: 4_000,
    miles: 303_830,
    city: "New York",
    state: "NY",
    zip: "10001",
    vdp: "https://stub.example/listing/civic-303k",
  }),
  stubCar({
    vin: "2HGFC2F59LH000004",
    year: 2020,
    make: "Honda",
    model: "Civic",
    bodyStyle: "Sedan",
    price: 14_000,
    miles: 40_000,
    city: "New York",
    state: "NY",
    zip: "10001",
    vdp: "https://stub.example/listing/civic-2020",
  }),
  stubCar({
    vin: "5YFBURHE5KP000005",
    year: 2019,
    make: "Toyota",
    model: "Corolla",
    bodyStyle: "Sedan",
    price: 13_000,
    miles: 35_000,
    city: "New York",
    state: "NY",
    zip: "10001",
    vdp: "https://stub.example/listing/corolla",
  }),
  stubCar({
    vin: "5XYPG4A59MG000006",
    year: 2021,
    make: "Kia",
    model: "Sorento",
    bodyStyle: "SUV",
    price: 19_000,
    miles: 30_000,
    city: "New York",
    state: "NY",
    zip: "10001",
    vdp: "https://stub.example/listing/sorento",
  }),
  stubCar({
    vin: "19XFC2F59FE000010",
    year: 2015,
    make: "Honda",
    model: "Civic",
    bodyStyle: "Sedan",
    price: 9_000,
    miles: 50_000,
    city: "Seattle",
    state: "WA",
    zip: "98101",
    vdp: "https://stub.example/listing/civic-seattle",
  }),
];

function numericWindow(spec) {
  if (!spec) return null;
  const range = String(spec).match(/^(\d+)?-(\d+)?$/);
  if (range) {
    return {
      lo: range[1] ? Number(range[1]) : null,
      hi: range[2] ? Number(range[2]) : null,
    };
  }
  if (/^\d+$/.test(String(spec))) {
    const exact = Number(spec);
    return { lo: exact, hi: exact };
  }
  return null;
}

function inWindow(value, spec) {
  const window = numericWindow(spec);
  if (!window) return true;
  if (window.lo != null && value < window.lo) return false;
  if (window.hi != null && value > window.hi) return false;
  return true;
}

function sameText(left, right) {
  return String(left).trim().toLowerCase() === String(right).trim().toLowerCase();
}

/** Honour year, price, miles, zip/distance, and make/model. Returns a fresh payload. */
export function filterStubListings(rawUrl) {
  const url = new URL(rawUrl, "http://127.0.0.1");
  const vinPath = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (vinPath[0] === "listings" && vinPath[1]) {
    const vin = decodeURIComponent(vinPath[1]).toUpperCase();
    const hit = STUB_CATALOG.find((row) => row.vin.toUpperCase() === vin);
    return {
      stubLabel: "STUB Auto.dev listings — fixture only",
      data: hit ? [hit] : [],
    };
  }
  const make = url.searchParams.get("vehicle.make");
  const model = url.searchParams.get("vehicle.model");
  const year = url.searchParams.get("vehicle.year");
  const price = url.searchParams.get("retailListing.price");
  const miles = url.searchParams.get("retailListing.miles");
  const zip = url.searchParams.get("zip");
  const distance = url.searchParams.get("distance");
  const maxMiles = distance != null && distance !== "" ? Number(distance) : null;
  const origin = zip ? ZIP_LAT_LON[zip] : null;

  const data = [];
  for (const row of STUB_CATALOG) {
    if (make && !sameText(row.vehicle.make, make)) continue;
    if (model && !sameText(row.vehicle.model, model)) continue;
    if (year && !inWindow(row.vehicle.year, year)) continue;
    if (price && !inWindow(row.retailListing.price, price)) continue;
    if (miles && !inWindow(row.retailListing.miles, miles)) continue;
    let distanceMiles = null;
    if (origin && Array.isArray(row.location)) {
      distanceMiles = haversineMiles(origin, [row.location[1], row.location[0]]);
      if (maxMiles != null && Number.isFinite(maxMiles) && distanceMiles > maxMiles) continue;
    } else if (maxMiles != null && zip && row.retailListing.zip !== zip) {
      continue;
    }
    const copy = JSON.parse(JSON.stringify(row));
    if (distanceMiles != null) copy.retailListing.distance = Math.round(distanceMiles);
    data.push(copy);
  }
  return { stubLabel: "STUB Auto.dev listings — fixture only", data };
}

function assertStub(cond, message) {
  if (!cond) throw new Error(message);
}

export function selfTestStubListings() {
  const rav4 = filterStubListings(
    "http://127.0.0.1/listings?vehicle.make=Toyota&vehicle.model=RAV4&retailListing.price=1-18900&retailListing.miles=0-80000&vehicle.year=1990-2027&zip=33101&distance=100",
  );
  assertStub(rav4.data.length === 4, `expected 4 RAV4s, got ${rav4.data.length}`);
  assertStub(rav4.data.every((row) => row.vehicle.model === "RAV4"), "RAV4 query leaked another model");
  const oldTruck = filterStubListings("http://127.0.0.1/listings?vehicle.year=2012&vehicle.make=Ford&vehicle.model=F-150");
  assertStub(oldTruck.data.length === 1 && oldTruck.data[0].vehicle.year === 2012, "exact year filter missed the 2012 F-150");
  const cheap = filterStubListings("http://127.0.0.1/listings?retailListing.price=1-5000");
  assertStub(cheap.data.length > 0 && cheap.data.every((row) => row.retailListing.price <= 5000), "price filter leaked");
  const lowMiles = filterStubListings("http://127.0.0.1/listings?retailListing.miles=0-50000&vehicle.make=Honda&vehicle.model=Civic");
  assertStub(lowMiles.data.every((row) => row.retailListing.miles <= 50_000), "miles filter leaked");
  const nearNyc = filterStubListings("http://127.0.0.1/listings?zip=10001&distance=100&vehicle.make=Honda&vehicle.model=Civic");
  assertStub(nearNyc.data.every((row) => row.retailListing.zip !== "98101"), "distance filter kept the Seattle Civic");
  const none = filterStubListings("http://127.0.0.1/listings?vehicle.make=Toyota&vehicle.model=RAV4&vehicle.year=1999");
  assertStub(none.data.length === 0, "year filter kept a 2021 RAV4 for 1999");
  const miami = filterStubListings(
    "http://127.0.0.1/listings?vehicle.make=Toyota&vehicle.model=RAV4&zip=33130&distance=100",
  );
  assertStub(miami.data.length === 4, `33130 within 100 miles should keep the Miami RAV4s, got ${miami.data.length}`);
}

/** Empty UI seed requires search_listings before finish — lock the stub order. */
export function selfTestStubAgentSearchThenFinish() {
  const schemaBody = (messages) => ({
    messages,
    response_format: { type: "json_schema", json_schema: { name: "find_agent_next_action" } },
  });
  const first = JSON.parse(servPayload(schemaBody([{ role: "user", content: "{}" }])).choices[0].message.content);
  assertStub(first.action === "search", `expected search before tool result, got ${first.action}`);
  const second = JSON.parse(
    servPayload(
      schemaBody([
        {
          role: "user",
          content: `Tool result for search_listings:\n${JSON.stringify({ ok: true, listings: [{ vin: STUB_RAV4_VINS[0] }] })}\nContinue with action search or finish.`,
        },
      ]),
    ).choices[0].message.content,
  );
  assertStub(second.action === "finish", `expected finish after search_listings, got ${second.action}`);
  assertStub(
    second.picks?.[0]?.vin === STUB_RAV4_VINS[0],
    `finish VIN must be a stub RAV4, got ${second.picks?.[0]?.vin}`,
  );
}

function schemaName(body) {
  return body?.response_format?.json_schema?.name ?? null;
}

function systemText(body) {
  const messages = body?.messages;
  const system = Array.isArray(messages) ? messages.find((row) => row.role === "system") : null;
  return typeof system?.content === "string" ? system.content : "";
}

function userText(body) {
  const messages = body?.messages;
  const user = Array.isArray(messages) ? messages.find((row) => row.role === "user") : null;
  return typeof user?.content === "string" ? user.content : "";
}

function negotiateVerdict(id) {
  // Note must not invent dollar amounts outside the facts JSON (quotedSafe).
  return chatCompletion(
    id,
    JSON.stringify({
      verdict: "negotiate",
      note: "Asking price is near the fair value of similar listings.",
    }),
  );
}

function chatCompletion(id, content) {
  return {
    id,
    object: "chat.completion",
    model: "stub-serv-model",
    choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    stubLabel: "STUB SERV completion — fixture only",
  };
}

function parseUserJson(body) {
  const raw = userText(body);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function keysFromFacts(user) {
  const facts = user?.facts && typeof user.facts === "object" ? user.facts : user;
  if (!facts || typeof facts !== "object") return [];
  const ranked = Array.isArray(facts.codeRankedKeys) ? facts.codeRankedKeys : [];
  const shortlist = Array.isArray(facts.shortlistKeys) ? facts.shortlistKeys : [];
  const pool = Array.isArray(facts.poolKeys) ? facts.poolKeys : [];
  const fromPoolRows = Array.isArray(facts.pool)
    ? facts.pool.map((row) => (row && typeof row.key === "string" ? row.key : null)).filter(Boolean)
    : [];
  const fromShortlistRows = Array.isArray(facts.shortlist)
    ? facts.shortlist.map((row) => (row && typeof row.key === "string" ? row.key : null)).filter(Boolean)
    : [];
  const codeRankedKey = typeof facts.codeRankedKey === "string" ? [facts.codeRankedKey] : [];
  return [...new Set([...ranked, ...shortlist, ...pool, ...fromPoolRows, ...fromShortlistRows, ...codeRankedKey])];
}

function servPayload(body) {
  const schema = schemaName(body);
  const system = systemText(body);
  const user = parseUserJson(body);

  if (schema === "find_plan") {
    // Same shape as find-radar-serv-acceptance offline fixture (validateFindPlan).
    return chatCompletion(
      "chatcmpl-EhAYL8BkOR3tLA0IvmYKYaDFasgEz",
      JSON.stringify({
        summary: "Toyota RAV4 under $18,000 near Miami for commuting.",
        bodyStyles: ["suv"],
        budget: { maxUsd: 18_000, approximate: false, quote: "under $18,000" },
        yearMin: null,
        yearMax: null,
        milesMax: 80_000,
        drivetrain: { value: "any", strength: "none", quote: null },
        fuel: { value: "any", strength: "none", quote: null },
        seatsMin: null,
        location: { zip: "33101", phrase: "near Miami", needsZip: false },
        priorities: [],
        namedModels: [{ make: "Toyota", model: "RAV4" }],
        excludedMakes: [],
        question: { id: "none", text: null },
        directions: [
          {
            label: "The model you named",
            why: "You named a Toyota RAV4.",
            bodyStyle: "suv",
            models: [{ make: "Toyota", model: "RAV4" }],
          },
        ],
      }),
    );
  }

  if (schema === "need_extract") {
    return chatCompletion(
      "chatcmpl-EhAYL8BkOR3tLA0IvmYKYaDFasgEz",
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
      }),
    );
  }

  if (schema === "find_triage") {
    const keys = keysFromFacts(user).slice(0, 8);
    const shortlist = (keys.length >= 3 ? keys : keys.concat(keys).concat(keys)).slice(0, Math.max(3, keys.length));
    return chatCompletion(
      "chatcmpl-EhAaTriageStubFindRadar01",
      JSON.stringify({
        shortlist: shortlist.map((key) => ({
          key,
          reason: "STUB triage shortlist — fixture only",
          evidenceIds: [`car:${key}`],
        })),
        rejected: [],
        perCarChecks: [],
        revisit: { needed: false, why: null, addModels: [], widenRadiusMiles: null },
      }),
    );
  }

  if (schema === "find_decide") {
    const keys = keysFromFacts(user);
    const pickKey = keys[0] || "stub-missing-key";
    const alt = keys.filter((k) => k !== pickKey).slice(0, 2);
    return chatCompletion(
      "chatcmpl-EhAaDecideStubFindRadar01",
      JSON.stringify({
        pickKey,
        action: "negotiate",
        confidence: "medium",
        confidenceWhy: "STUB decide — asking price is near similar listings.",
        reasons: [
          {
            text: "Asking price is near the fair value of similar listings.",
            evidenceIds: [`car:${pickKey}`],
          },
        ],
        watchOuts: [
          {
            text: "Get a history report and a pre-purchase inspection before you buy.",
            evidenceIds: [`car:${pickKey}`],
          },
        ],
        askSeller: ["Ask for service records."],
        alternatives: alt.map((key) => ({ key, whyNot: "STUB alternative — fixture only" })),
        offerUsd: null,
      }),
    );
  }

  if (schema === "find_challenge") {
    return chatCompletion(
      "chatcmpl-EhAaChallengeStubFindRadar1",
      JSON.stringify({
        agree: true,
        issues: [],
        revised: { pickKey: null, action: null, confidence: null },
      }),
    );
  }

  // Agentic Find/Resale loop schemas. E2E stubs SERV — never classic code path.
  // With empty UI seed (Task 5), finish VINs must come from search_listings tool
  // results — search first, then finish. Finishing immediately → invented VIN →
  // repair forever → maxRounds runaway.
  if (schema === "find_agent_next_action" || schema === "find_agent_result") {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const sawSearchResult = messages.some(
      (row) =>
        typeof row?.content === "string" && row.content.includes("Tool result for search_listings"),
    );
    if (!sawSearchResult) {
      return chatCompletion(
        "chatcmpl-EhAaFindAgentSearch01",
        JSON.stringify({
          action: "search",
          make: "Toyota",
          model: "RAV4",
          bodyStyle: "suv",
          priceMaxUsd: 18_000,
          milesMax: 80_000,
          yearMin: null,
          yearMax: null,
          zip: "33101",
          radiusMi: 100,
          fuel: null,
          drivetrain: null,
          sort: null,
          limit: 12,
          searchWhy: "STUB agent search — named RAV4 near Miami under budget.",
          summary: null,
          confidence: null,
          picks: null,
          relaxedConditions: null,
          passReason: null,
        }),
      );
    }
    const vin = STUB_RAV4_VINS[0];
    const finish = {
      action: "finish",
      make: null,
      model: null,
      bodyStyle: null,
      priceMaxUsd: null,
      milesMax: null,
      yearMin: null,
      yearMax: null,
      zip: null,
      radiusMi: null,
      fuel: null,
      drivetrain: null,
      sort: null,
      limit: null,
      searchWhy: null,
      summary: "STUB agent finish — fixture only. Negotiate on the listed RAV4.",
      confidence: "medium",
      picks: [
        {
          vin,
          label: "2021 Toyota RAV4",
          action: "negotiate",
          offerUsd: 14_500,
          why: "STUB agent pick — asking near similar listings.",
        },
      ],
      relaxedConditions: [],
      passReason: null,
    };
    return chatCompletion("chatcmpl-EhAaFindAgentNextAction01", JSON.stringify(finish));
  }

  if (schema === "resale_agent_next_action" || schema === "resale_agent_result") {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const sawSearchResult = messages.some(
      (row) =>
        typeof row?.content === "string" && row.content.includes("Tool result for search_listings"),
    );
    if (!sawSearchResult) {
      return chatCompletion(
        "chatcmpl-EhAaResaleAgentSearch01",
        JSON.stringify({
          action: "search",
          make: "Toyota",
          model: "RAV4",
          bodyStyle: "suv",
          priceMaxUsd: 18_000,
          milesMax: 80_000,
          yearMin: null,
          yearMax: null,
          zip: "33101",
          radiusMi: 100,
          fuel: null,
          drivetrain: null,
          sort: null,
          limit: 12,
          searchWhy: "STUB resale agent search — fixture only.",
          summary: null,
          confidence: null,
          picks: null,
          relaxedConditions: null,
          passReason: null,
        }),
      );
    }
    const vin = STUB_RAV4_VINS[0];
    return chatCompletion(
      "chatcmpl-EhAaResaleAgentNextAction01",
      JSON.stringify({
        action: "finish",
        make: null,
        model: null,
        bodyStyle: null,
        priceMaxUsd: null,
        milesMax: null,
        yearMin: null,
        yearMax: null,
        zip: null,
        radiusMi: null,
        fuel: null,
        drivetrain: null,
        sort: null,
        limit: null,
        searchWhy: null,
        summary: "STUB resale agent finish — fixture only.",
        confidence: "medium",
        picks: [{ vin, action: "negotiate", offerUsd: 14_500, why: "STUB resale pick." }],
        relaxedConditions: [],
      }),
    );
  }

  if (schema === "find_pick") {
    // pickKey must be clamped to allowlisted finalists by code; empty → code fallback.
    // Return a note that only repeats stub listing facts (no invented dollars).
    // Include alternatives/reasons/watchFor so strict find_pick schema accepts the stub.
    return chatCompletion(
      "chatcmpl-EhAa2CKFP1jFUHXA4zkovlrEvHLiD",
      JSON.stringify({
        pickKey: null,
        alternatives: [],
        action: "negotiate",
        confidence: "medium",
        note: "Asking price is near the fair value of similar listings.",
        reasons: ["Asking price is near the fair value of similar listings."],
        watchFor: ["Get a history report and a pre-purchase inspection before you buy."],
        evidenceIds: [],
      }),
    );
  }

  const userRaw = userText(body);
  if (
    schema === "report_verdict_decision" ||
    userRaw.includes("fairValueUsd") ||
    userRaw.includes("allowedActions") ||
    /verdict_decide|Buy\/Negotiate\/Pass|shopper verdict/i.test(system)
  ) {
    const radar = /radar|alert|watch/i.test(system) || userRaw.includes("alertWorthy");
    return negotiateVerdict(radar ? "chatcmpl-EhAYY9x6TMkVDYpmLDnwVyxN4B1wM" : "chatcmpl-EhAYgC3yCPXLLZEYAvYAWkyIL0uuX");
  }
  if (schema === "report_verdict_challenge") {
    return chatCompletion(
      "chatcmpl-EhAYmZQKMGVzpcD9vjLj0JrVMdwFd",
      JSON.stringify({
        agrees: true,
        action: "negotiate",
        objection: null,
        evidenceIds: ["ev_reason_0"],
      }),
    );
  }

  if (schema === "flip_alert_judgment" || /radar_review|alert.?judgment/i.test(system)) {
    return negotiateVerdict("chatcmpl-EhAYY9x6TMkVDYpmLDnwVyxN4B1wM");
  }

  if (schema === "find_next_check_choice") {
    return chatCompletion(
      "chatcmpl-EhAYvmQKEngaZdsyEb89s3IxFZJwJ",
      JSON.stringify({
        checkId: "free_gov_fuel",
        reason: "STUB next-check — fixture only",
      }),
    );
  }

  // need_guard / check_guard / radar_guard — interpretGuard expects ALLOW
  if (/guard|shopping for a car|screen/i.test(system) || !schema) {
    return chatCompletion("chatcmpl-EhAZ1PxveVDMQMYRff1YKUcavC8F4", "ALLOW");
  }

  return chatCompletion(
    "chatcmpl-EhAZMtE9f15kexMDuMak1gsA6nSXy",
    JSON.stringify({ ok: true, note: "STUB generic — fixture only" }),
  );
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  res.setHeader("content-type", "application/json");
  res.setHeader("x-lemonless-stub", "1");

  if (url.pathname.startsWith("/listings")) {
    res.writeHead(200);
    res.end(JSON.stringify(filterStubListings(url)));
    return;
  }

  // Auto.dev ZIP geocode — required before /listings when a buyer-center ZIP is set.
  const zipMatch = url.pathname.match(/^\/zip\/(\d{5})(?:-\d{4})?\/?$/);
  if (zipMatch) {
    const zip = zipMatch[1];
    const coords = ZIP_LAT_LON[zip];
    if (!coords) {
      res.writeHead(404);
      res.end(
        JSON.stringify({
          success: false,
          error: { message: `STUB ZIP ${zip} not geocoded` },
          stub: true,
        }),
      );
      return;
    }
    res.writeHead(200);
    res.end(
      JSON.stringify({
        success: true,
        stub: true,
        payload: {
          zip,
          city: zip === "33101" || zip === "33130" ? "Miami" : "Stubville",
          state: zip.startsWith("33") ? "FL" : "XX",
          latitude: coords[0],
          longitude: coords[1],
        },
      }),
    );
    return;
  }

  if (
    (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") &&
    req.method === "POST"
  ) {
    const body = await readJson(req);
    res.writeHead(200);
    res.end(JSON.stringify(servPayload(body)));
    return;
  }

  if ((url.pathname === "/v1/responses" || url.pathname === "/responses") && req.method === "POST") {
    const body = await readJson(req);
    const chat = servPayload(body);
    res.writeHead(200);
    res.end(
      JSON.stringify({
        id: chat.id.replace("chatcmpl-", "resp-"),
        object: "response",
        model: chat.model,
        output_text: chat.choices[0].message.content,
        stubLabel: "STUB SERV responses — fixture only",
      }),
    );
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, stub: true }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "not_found", stub: true }));
});

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly && process.argv.includes("--self-test")) {
  selfTestStubListings();
  selfTestStubAgentSearchThenFinish();
  console.log("stub self-test ok");
} else if (invokedDirectly) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[e2e-stub] listening on http://127.0.0.1:${PORT} (STUB upstreams — fixture only)`);
  });
}
