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

const PORT = Number(process.env.PORT || 8791);

const STUB_LISTINGS = {
  stubLabel: "STUB Auto.dev listings — fixture only",
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

function servPayload(body) {
  const schema = schemaName(body);
  const system = systemText(body);

  if (schema === "need_extract") {
    return chatCompletion(
      "synthetic-test-StubNeedExtract01",
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

  const user = userText(body);
  if (
    schema === "report_verdict_decision" ||
    user.includes("fairValueUsd") ||
    user.includes("allowedActions") ||
    /verdict_decide|Buy\/Negotiate\/Pass|shopper verdict/i.test(system)
  ) {
    const radar = /radar|alert|watch/i.test(system) || user.includes("alertWorthy");
    return negotiateVerdict(radar ? "synthetic-test-StubRadarDecide01" : "synthetic-test-StubFindDecide01");
  }
  if (schema === "report_verdict_challenge") {
    return chatCompletion(
      "synthetic-test-StubFindChallenge01",
      JSON.stringify({
        agrees: true,
        action: "negotiate",
        objection: null,
        evidenceIds: ["ev_reason_0"],
      }),
    );
  }

  if (schema === "flip_alert_judgment" || /radar_review|alert.?judgment/i.test(system)) {
    return negotiateVerdict("synthetic-test-StubRadarDecide01");
  }

  if (schema === "find_next_check_choice") {
    return chatCompletion(
      "synthetic-test-StubNextCheck01",
      JSON.stringify({
        checkId: "free_gov_fuel",
        reason: "STUB next-check — fixture only",
      }),
    );
  }

  // need_guard / check_guard / radar_guard — interpretGuard expects ALLOW
  if (/guard|shopping for a car|screen/i.test(system) || !schema) {
    return chatCompletion("synthetic-test-StubNeedGuard01", "ALLOW");
  }

  return chatCompletion(
    "synthetic-test-StubGeneric01",
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
        id: chat.id.startsWith("synthetic-test-")
          ? chat.id.replace("synthetic-test-", "synthetic-test-resp-")
          : chat.id.replace("chatcmpl-", "resp-"),
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
