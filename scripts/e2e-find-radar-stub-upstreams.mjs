#!/usr/bin/env node
/**
 * STUB upstreams for Find/Radar HTTP acceptance (CI / local).
 * Clearly labelled fixture responses — never treat as live Auto.dev or SERV results.
 *
 * Serves:
 *   GET/POST /listings*          → Auto.dev-shaped inventory (STUB)
 *   POST /v1/chat/completions    → SERV-shaped chat completions (STUB)
 *   POST /v1/responses           → SERV responses endpoint (STUB)
 *
 * Env: PORT (default 8791)
 */
import http from "node:http";

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
const STUB_LISTINGS = {
  stubLabel: "STUB Auto.dev listings — fixture only",
  data: [14_900, 17_000, 17_500, 18_000].map((price, index) => ({
    vin: STUB_RAV4_VINS[index],
    vehicle: {
      vin: STUB_RAV4_VINS[index],
      year: 2021,
      make: "Toyota",
      model: "RAV4",
      bodyStyle: "SUV",
    },
    retailListing: {
      price,
      // All under the stub need milesMax (80k) so match returns 3+ peers for settle comps.
      miles: 40_000 + index * 8_000,
      city: "Miami",
      state: "FL",
      zip: "33101",
      used: true,
      vdp: `https://stub.example/listing/${index}`,
    },
    history: null,
  })),
};

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
    res.end(JSON.stringify(STUB_LISTINGS));
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[e2e-stub] listening on http://127.0.0.1:${PORT} (STUB upstreams — fixture only)`);
});
