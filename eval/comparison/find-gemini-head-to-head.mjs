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
const EVAL_SECRET = (process.env.EVAL_LIVE_SECRET || "").trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-3.8-flash").trim();
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
  const endpoint = ORIGIN + "/api/internal/eval-live";
  const headers = { authorization: "Bearer " + EVAL_SECRET };
  const started = await postJson(endpoint, headers, {
    action: "start",
    maxQueries: 1,
    notes: [{ product: "find", note: PROMPT, zip: "80202" }],
    servVerdictFeatures: "on",
  }, "Find start");

  let report = started.json;
  const batchId = report.batchId;
  if (typeof batchId !== "string" || !batchId) {
    throw new Error("Find start did not return a batchId: " + JSON.stringify(report).slice(0, 1500));
  }

  let hops = 0;
  const hopEvents = [];
  while (report.done !== true && hops < 50) {
    hops += 1;
    const step = await postJson(endpoint, headers, { action: "step", batchId }, "Find step " + hops);
    report = step.json;
    hopEvents.push({
      at: new Date().toISOString(),
      requestId: step.requestId,
      hopStatus: report.hopStatus || report.lastHop?.status || null,
      httpStatus: report.lastHop?.httpStatus || null,
      queryId: report.queryId || null,
      sessionId: report.sessionId || report.active?.sessionId || null,
      asked: report.asked ?? report.active?.asked ?? false,
      briefConfirmed: report.briefConfirmed ?? report.active?.briefConfirmed ?? false,
    });
  }
  if (report.done !== true) throw new Error("Find did not complete after " + hops + " chat hops.");

  const caseResult = Array.isArray(report.results) ? report.results[0] : null;
  if (!caseResult) throw new Error("Completed Find batch did not contain a result.");
  let publicRun = null;
  let publicRunError = null;
  if (typeof caseResult.runId === "string" && caseResult.runId) {
    try {
      const response = await fetch(ORIGIN + "/api/run/" + encodeURIComponent(caseResult.runId), {
        headers: { accept: "application/json" },
      });
      const text = await response.text();
      try { publicRun = JSON.parse(text); } catch { publicRun = { nonJson: text.slice(0, 1000) }; }
      if (!response.ok) publicRunError = "Public run read returned HTTP " + response.status;
    } catch (error) {
      publicRunError = String(error);
    }
  }

  return {
    status: caseResult.ok ? "completed" : "completed_with_find_error",
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: caseResult.durationMs ?? caseResult.elapsedMs ?? null,
    endpoint: endpoint,
    batchId,
    batchReport: report,
    result: caseResult,
    publicRunUrl: caseResult.runId ? ORIGIN + "/run/" + caseResult.runId : null,
    publicRunJsonUrl: caseResult.runId ? ORIGIN + "/api/run/" + caseResult.runId : null,
    publicRun,
    publicRunError,
    hopEvents,
    httpRequestId: started.requestId,
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
  if (!EVAL_SECRET) throw new Error("EVAL_LIVE_SECRET is missing. No Find call was made.");
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
      "Find is driven through the production Find chat implementation via the internal eval endpoint; skipCredit=true, so no Lemonless report credit is charged.",
      "This is one use case repeated twice, not a statistically general benchmark.",
      "Search inventory can change between T0 and T+10; compare listing evidence and timestamps before calling answer changes inconsistent.",
      "Accident-free/salvage, AWD and out-the-door price require independent evidence; listing feed accidentCount=0 is not proof.",
      "The public Find run record is retained when the endpoint returns a runId.",
      "Google Search grounding is unavailable on the Gemini API Free tier. On the paid tier Google lists 5,000 monthly free Search grounding requests for Gemini 3+ shared usage, then $14 per 1,000 search queries; model token charges apply on paid tier. Actual entitlement and billing depend on the API project.",
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
