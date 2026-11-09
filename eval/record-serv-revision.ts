/**
 * Live recorder: capture a REAL SERV verdict revision + second check for /report/sample.
 *
 * Does NOT invent responses. Requires:
 *   COMPARISON_ALLOW_PAID=1 SERV_API_KEY=… npm run eval:record-serv-revision
 *
 * Flow (real sample Camry rows only — no invented comps):
 * 1) verdict_decide on subject + first comps subset
 * 2) verdict_decide again after adding the remaining sample comps as newer asks
 * 3) verdict_challenge on the revised choice
 * 4) Write fixtures/serv/recordings/verdict-revision.latest.json with raw traces
 *
 * If first and revised verdicts do not differ, exits non-zero without writing —
 * the sample page must not replay a no-op as a "revision".
 *
 * Do not run in CI. Owner runs this when ready to spend SERV.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseServVerdict } from "../src/domain/verdict-decide";
import { sampleListings } from "../src/io/sample";
import { BASE_MODEL, runServ, type ServResult } from "../src/server/serv";
import {
  SERV_REVISION_RECORDING_PATH,
  SERV_REVISION_RECORDING_SCHEMA,
  type ServRevisionHttpTrace,
  type ServRevisionRecording,
} from "../src/server/serv-revision-recording";

function refuseUnlessPaid() {
  if (process.env.COMPARISON_DRY_RUN === "1") {
    throw new Error("COMPARISON_DRY_RUN=1 — refusing live SERV spend.");
  }
  if (process.env.COMPARISON_ALLOW_PAID !== "1") {
    throw new Error("Set COMPARISON_ALLOW_PAID=1 to allow live SERV recording.");
  }
  if (!process.env.SERV_API_KEY?.trim()) {
    throw new Error("SERV_API_KEY required.");
  }
}

function openservFrom(result: Extract<ServResult, { ok: true }>) {
  const id = result.proof.openserv?.id;
  return {
    runId: null as string | null,
    stepId: null as string | null,
    responseId: typeof id === "string" ? id : null,
  };
}

function trace(
  profile: string,
  model: string,
  user: string,
  facts: Record<string, unknown>,
  result: Extract<ServResult, { ok: true }>,
): ServRevisionHttpTrace {
  return {
    request: { profile, model, user, facts },
    rawResponse: result.text,
    httpStatus: result.rawStatus,
    openserv: openservFrom(result),
    latencyMs: result.proof.latencyMs,
  };
}

async function main() {
  refuseUnlessPaid();
  const model = process.env.SERV_MODEL?.trim() || BASE_MODEL;
  const apiKey = process.env.SERV_API_KEY;
  const listings = sampleListings();
  const subject = listings[0];
  if (!subject) throw new Error("sample listings empty");
  // Split real sample rows: first pool vs added newer asks (same fixture, no invented cars).
  const firstComps = listings.slice(1, 3).map((row) => ({
    vin: row.vin,
    year: row.year,
    make: row.make,
    model: row.model,
    priceUsd: row.priceUsd,
    miles: row.miles,
  }));
  const newerComps = listings.slice(3).map((row) => ({
    vin: row.vin,
    year: row.year,
    make: row.make,
    model: row.model,
    priceUsd: row.priceUsd,
    miles: row.miles,
  }));
  if (firstComps.length < 2 || newerComps.length < 1) {
    throw new Error("Need enough sample listings to form first comps and newer comps.");
  }

  const allowedEvidenceIds = [
    "ev_fair_value",
    "ev_comp_count",
    "ev_ask",
    "ev_recall_unavailable",
    ...firstComps.map((c) => `ev_comp_${c.vin}`),
    ...newerComps.map((c) => `ev_comp_${c.vin}`),
  ];

  const baseFacts = {
    subject: {
      vin: subject.vin,
      year: subject.year,
      make: subject.make,
      model: subject.model,
      priceUsd: subject.priceUsd,
      miles: subject.miles,
    },
    comps: firstComps,
    recallsAvailable: false,
    evidenceIds: allowedEvidenceIds.slice(0, 4 + firstComps.length),
  };

  const firstUser = [
    "Decide buy|negotiate|pass|needs_inspection from these calculated facts only.",
    "Do not invent dollar amounts. Cite evidence ids from the facts when you explain.",
    JSON.stringify(baseFacts),
  ].join("\n");

  console.log("Recording first verdict_decide…");
  const first = await runServ(
    "verdict_decide",
    { user: firstUser, facts: baseFacts },
    { apiKey, model, fetch, transportPolicy: "experiment_single_attempt" },
  );
  if (!first.ok) throw new Error(`first verdict_decide failed: ${first.error}`);
  const firstParsed = parseServVerdict(first.text);
  if (!firstParsed) throw new Error("first response did not parse as verdict JSON");

  const revisedFacts = {
    ...baseFacts,
    comps: [...firstComps, ...newerComps],
    evidenceIds: allowedEvidenceIds,
    note: "Additional similar listings from the same labeled sample set were added to the comps pool.",
  };
  const revisedUser = [
    "New similar listings were added to the comps pool. Re-decide buy|negotiate|pass|needs_inspection.",
    "Do not invent dollar amounts.",
    `Previous choice: ${firstParsed.verdict}`,
    JSON.stringify(revisedFacts),
  ].join("\n");

  console.log("Recording revised verdict_decide…");
  const revised = await runServ(
    "verdict_decide",
    { user: revisedUser, facts: revisedFacts },
    { apiKey, model, fetch, transportPolicy: "experiment_single_attempt" },
  );
  if (!revised.ok) throw new Error(`revised verdict_decide failed: ${revised.error}`);
  const revisedParsed = parseServVerdict(revised.text);
  if (!revisedParsed) throw new Error("revised response did not parse as verdict JSON");

  if (firstParsed.verdict === revisedParsed.verdict) {
    throw new Error(
      `Live run did not revise (${firstParsed.verdict} → ${revisedParsed.verdict}). Refusing to write a no-op recording.`,
    );
  }

  const challengeUser = [
    "Independently challenge the shopper verdict. Return JSON:",
    "{agrees:boolean, action:buy|negotiate|pass|needs_inspection, objection:string|null, evidenceIds:string[]}",
    "evidenceIds must come from the facts set. Do not invent dollars.",
    `Primary action: ${revisedParsed.verdict}`,
    JSON.stringify(revisedFacts),
  ].join("\n");

  console.log("Recording verdict_challenge…");
  const challenge = await runServ(
    "verdict_challenge",
    { user: challengeUser, facts: revisedFacts },
    { apiKey, model, fetch, transportPolicy: "experiment_single_attempt" },
  );
  if (!challenge.ok) throw new Error(`verdict_challenge failed: ${challenge.error}`);

  const recording: ServRevisionRecording = {
    schema: SERV_REVISION_RECORDING_SCHEMA,
    recordedAt: new Date().toISOString(),
    model,
    costUsd: null,
    costNote: "Cost unknown until billing reconciliation; three SERV HTTP calls recorded.",
    subject: {
      vin: subject.vin,
      year: subject.year,
      make: subject.make,
      model: subject.model,
      askUsd: subject.priceUsd,
    },
    first: { ...trace("verdict_decide", model, firstUser, baseFacts, first), parsed: firstParsed },
    revised: {
      ...trace("verdict_decide", model, revisedUser, revisedFacts, revised),
      parsed: revisedParsed,
    },
    challenge: trace("verdict_challenge", model, challengeUser, revisedFacts, challenge),
    allowedEvidenceIds,
    provenance: "Live capture via npm run eval:record-serv-revision",
  };

  mkdirSync(dirname(SERV_REVISION_RECORDING_PATH), { recursive: true });
  writeFileSync(SERV_REVISION_RECORDING_PATH, `${JSON.stringify(recording, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        wrote: SERV_REVISION_RECORDING_PATH,
        first: firstParsed.verdict,
        revised: revisedParsed.verdict,
        model,
        recordedAt: recording.recordedAt,
        responseIds: {
          first: recording.first.openserv?.responseId ?? null,
          revised: recording.revised.openserv?.responseId ?? null,
          challenge: recording.challenge.openserv?.responseId ?? null,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
