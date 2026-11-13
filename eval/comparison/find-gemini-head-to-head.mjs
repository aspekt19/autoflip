import { MemoryKv } from "../../src/io/kv";
import { runFindChatTurn } from "../../src/server/find-chat";

/**
 * Two-round, real Find vs Gemini Search-grounded comparison.
 * Run only from the manually dispatched live-eval workflow on the PR branch.
 * The Find side uses production /api/internal/eval-live (runFindChatTurn),
 * so it exercises the actual Find chat/search/verdict path while skipCredit=true.
 *
 * Required env: EVAL_LIVE_URL, EVAL_LIVE_SECRET, GEMINI_API_KEY.
 * Never prints secret values. Writes raw responses and metadata under OUTPUT_DIR.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ORIGIN = (process.env.EVAL_LIVE_URL || "https://autoflip-umber.vercel.app").replace(/\/$/, "");
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const SERV_API_KEY = (process.env.SERV_API_KEY || "").trim();
const AUTODEV_API_KEY = (process.env.AUTODEV_API_KEY || "").trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || "eval/results/find-gemini-head-to-head-2026-11-13");
const WAIT_MS = 10 * 60 * 1000;

export const PROMPT =
  "I'm in Denver 80202, budget $25k all-in, need an AWD SUV for mountain winters and a 40-mile daily commute. Two kids, so safety matters most. Under 100k miles, no accident or salvage history, low fuel cost. Within 75 miles. Which one should I buy and what should I offer?";

const CRITERIA = [
  { id: "hard_constraints", label: "Hard constraint satisfaction", weight: 25 },
  { id: "vin_awd_history", label: "VIN, AWD and accident/title-history verification", weight: 20 },
  { id: "safety_children", label: "Safety and child passengers", weight: 20 },
  { id: "ownership_cost", label: "Ownership cost and fuel economy", weight: 15 },
  { id: "offer_rationale", label: "Offer and price rationale", weight: 15 },
  { id: "explanation", label: "Evidence quality and explanation", weight: 5 },
];

function writeJson(name, value) {
  writeFileSync(path.join(OUTPUT_DIR, name), JSON.stringify(value, null, 2) + "\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url, headers, body, label) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(label + " returned non-JSON HTTP " + response.status + ": " + text.slice(0, 500));
  }
  if (!response.ok) {
    throw new Error(label + " failed with HTTP " + response.status + ": " + JSON.stringify(json).slice(0, 1000));
  }
  return { json, status: response.status, requestId: response.headers.get("x-request-id") || response.headers.get("x-vercel-id") || null };
}

async function runFind(roundId) {
  const startedAt = new Date().toISOString();
  const kv = new MemoryKv();
  const userId = "find-gemini-eval-" + roundId;
  const turns = [];
  let sessionId = null;
  let lastBody = null;
  let lastStatus = null;
  let finalHttpStatus = null;

  const constraintsReply =
    "Please keep every requirement from my original request unchanged: Denver ZIP 80202; " +
    "$25,000 maximum out-the-door total including taxes, title, registration and dealer fees; " +
    "AWD SUV; mountain winters; a 40-mile daily commute; two children with safety as the top priority; " +
    "under 100,000 miles; no accident or salvage history; low fuel cost; within 75 miles. " +
    "Do not relax any of these constraints. Please use them exactly when preparing the brief.";

  async function turn(input) {
    const at = new Date().toISOString();
    const response = await runFindChatTurn({
      kv,
      userId,
      sessionId,
      message: input.message ?? null,
      continue: input.continue === true,
      confirmBrief: input.confirmBrief === true,
      skipCredit: true,
      servKey: SERV_API_KEY,
      autodevKey: AUTODEV_API_KEY,
      servBaseUrl: process.env.SERV_BASE_URL || undefined,
    });
    lastBody = response.body;
    finalHttpStatus = response.status;
    if (typeof response.body.sessionId === "string") sessionId = response.body.sessionId;
    lastStatus = typeof response.body.status === "string" ? response.body.status : null;
    turns.push({
      startedAt: at,
      finishedAt: new Date().toISOString(),
      httpStatus: response.status,
      ok: response.ok,
      status: lastStatus,
      request: input,
      response: response.body,
    });
    return response;
  }

  await turn({ message: PROMPT });
  let hops = 1;
  while (lastStatus !== "done" && hops < 50) {
    if (lastStatus === "ask") {
      await turn({ message: constraintsReply });
    } else if (lastStatus === "brief") {
      await turn({ confirmBrief: true });
    } else if (lastStatus === "continue" || lastStatus === "searching" || lastStatus === "progress") {
      await turn({ continue: true });
    } else {
      throw new Error("Find stopped before a terminal result (status=" + String(lastStatus) + "). Last response: " +
        JSON.stringify(lastBody).slice(0, 1800));
    }
    hops += 1;
  }
  if (lastStatus !== "done") {
    throw new Error("Find did not complete after " + hops + " chat turns.");
  }

  const result = lastBody && typeof lastBody.result === "object" ? lastBody.result : null;
  const runId = result && typeof result.runId === "string" ? result.runId : null;
  const agentLoop = result && typeof result.agentLoop === "object" ? result.agentLoop : null;
  return {
    status: result?.ok === false ? "completed_with_find_error" : "completed",
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - new Date(startedAt).getTime(),
    execution: "runFindChatTurn (same server-side Find chat implementation); MemoryKv; skipCredit=true",
    runId,
    result,
    finalBody: lastBody,
    finalHttpStatus,
    servResponseIds: agentLoop?.servResponseIds || [],
    servUsageTotal: agentLoop?.servUsageTotal || null,
    journalToolCalls: agentLoop?.journalToolCalls ?? null,
    journalServCalls: agentLoop?.journalServCalls ?? null,
    featuresActive: agentLoop?.featuresActive || [],
    conversation: turns,
    turns: hops,
    publicRunUrl: null,
    note: "This is a local eval invocation of the same Find server function, not a browser-session recording. It uses a fresh in-memory KV and does not charge report credits.",
  };
}

async function runGemini(roundId) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(GEMINI_MODEL) + ":generateContent";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: PROMPT }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 4096 },
    }),
  });
  const text = await response.text();
  let raw;
  try { raw = JSON.parse(text); } catch {
    throw new Error("Gemini returned non-JSON HTTP " + response.status + ": " + text.slice(0, 1000));
  }
  if (!response.ok) {
    throw new Error("Gemini failed with HTTP " + response.status + ": " + JSON.stringify(raw).slice(0, 2000));
  }

  const candidate = raw.candidates?.[0] || null;
  const parts = candidate?.content?.parts || [];
  const answer = parts.map((part) => typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n");
  const grounding = candidate?.groundingMetadata || {};
  const groundingChunks = Array.isArray(grounding.groundingChunks)
    ? grounding.groundingChunks.map((chunk) => ({
        uri: chunk.web?.uri || null,
        title: chunk.web?.title || null,
      })).filter((chunk) => chunk.uri || chunk.title)
    : [];
  return {
    status: "completed",
    startedAt,
    finishedAt: new Date().toISOString(),
    latencyMs: Date.now() - started,
    model: GEMINI_MODEL,
    endpoint: "generateContent",
    responseId: raw.responseId || raw.response_id || null,
    answer,
    webSearchQueries: grounding.webSearchQueries || [],
    groundingChunks,
    groundingSupports: grounding.groundingSupports || [],
    usageMetadata: raw.usageMetadata || null,
    promptFeedback: raw.promptFeedback || null,
    rawResponse: raw,
  };
}

async function runPair(roundId) {
  const startedAt = new Date().toISOString();
  const settled = await Promise.allSettled([runFind(roundId), runGemini(roundId)]);
  const find = settled[0].status === "fulfilled"
    ? settled[0].value
    : { status: "failed", error: String(settled[0].reason) };
  const gemini = settled[1].status === "fulfilled"
    ? settled[1].value
    : { status: "failed", error: String(settled[1].reason) };
  const pair = { id: roundId, startedAt, finishedAt: new Date().toISOString(), find, gemini };
  writeJson(roundId + ".json", pair);
  if (find.status === "failed" || gemini.status === "failed") {
    throw new Error(roundId + " pair incomplete. Evidence was saved; Find=" + find.status + ", Gemini=" + gemini.status);
  }
  return pair;
}

async function main() {
  if (!SERV_API_KEY || !AUTODEV_API_KEY) throw new Error("SERV_API_KEY and AUTODEV_API_KEY are required. No Find call was made.");
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing. No provider calls were made.");
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const experiment = {
    schemaVersion: 1,
    experiment: "Lemonless Find vs Gemini with Google Search grounding",
    prompt: PROMPT,
    zip: "80202",
    runDesign: "T0 Find and Gemini in parallel; repeat the same exact prompt with the same model and settings no earlier than T+10 minutes.",
    model: { provider: "Google", id: GEMINI_MODEL, grounding: "google_search" },
    criteria: CRITERIA,
    pricingReference: "https://ai.google.dev/gemini-api/docs/pricing",
    groundingReference: "https://ai.google.dev/gemini-api/docs/google-search",
    disclosures: [
      "Find is driven directly through the same runFindChatTurn server implementation used by /api/find/chat, with MemoryKv and skipCredit=true; no report credit is charged and no production data is mutated.",
      "This is one use case repeated twice, not a statistically general benchmark.",
      "Search inventory can change between T0 and T+10; compare listing evidence and timestamps before calling answer changes inconsistent.",
      "Accident-free/salvage, AWD and out-the-door price require independent evidence; listing feed accidentCount=0 is not proof.",
      "The public Find run record is retained when the endpoint returns a runId.",
      "For the selected gemini-2.5-flash model, Google lists Free Tier input/output tokens and Google Search grounding free up to 500 requests per day, shared with Gemini 2.5 Flash-Lite. The model is deprecated and scheduled to stop being selectable in AI Studio; direct API requests remain available through November 30, 2026, then route to Gemini 3.5 Flash-Lite from December 1. The test must run before that cutoff.",
      "Token usage and grounding-query count are provider telemetry, not a billing invoice. Exact cost is not asserted unless returned by the provider.",
    ],
    startedAt: new Date().toISOString(),
    rounds: [],
  };
  writeJson("experiment.json", experiment);

  const t0 = await runPair("t0");
  experiment.rounds.push(t0);
  experiment.t0FinishedAt = new Date().toISOString();
  writeJson("experiment.json", experiment);

  const t10Target = new Date(new Date(t0.startedAt).getTime() + WAIT_MS);
  const remaining = t10Target.getTime() - Date.now();
  if (remaining > 0) {
    console.log("T+10 round scheduled after " + Math.ceil(remaining / 1000) + " seconds from T0 start.");
    await sleep(remaining);
  }
  const t10 = await runPair("t10");
  experiment.rounds.push(t10);
  experiment.finishedAt = new Date().toISOString();
  experiment.t10OffsetMs = new Date(t10.startedAt).getTime() - new Date(t0.startedAt).getTime();
  experiment.status = "completed";
  writeJson("experiment.json", experiment);
  console.log("Completed T0 and T+10 Find vs Gemini. Evidence directory: " + OUTPUT_DIR);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
