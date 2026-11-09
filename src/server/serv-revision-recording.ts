/**
 * Load a REAL SERV revision recording for /report/sample replay.
 * Invented / agent-written JSON is never accepted here.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyAgentSecondPass } from "@/domain/agent-second-pass";
import type { AgentSecondPassResult } from "@/domain/agent-verdict-schema";
import { parseServVerdict, type ServVerdictPayload } from "@/domain/verdict-decide";
import type { DecisionAction } from "@/domain/decision-action";

export const SERV_REVISION_RECORDING_SCHEMA = "lemonless.serv_revision_recording.v1" as const;

export const SERV_REVISION_RECORDING_PATH = resolve(
  process.cwd(),
  "fixtures/serv/recordings/verdict-revision.latest.json",
);

export type ServRevisionHttpTrace = {
  request: {
    profile: string;
    model: string;
    user: string;
    facts?: Record<string, unknown>;
  };
  rawResponse: string;
  httpStatus?: number | null;
  openserv?: {
    runId?: string | null;
    stepId?: string | null;
    responseId?: string | null;
  };
  latencyMs?: number | null;
};

export type ServRevisionRecording = {
  schema: typeof SERV_REVISION_RECORDING_SCHEMA;
  recordedAt: string;
  model: string;
  costUsd: number | null;
  costNote: string | null;
  subject: {
    vin?: string | null;
    url?: string | null;
    year?: number | null;
    make?: string | null;
    model?: string | null;
    askUsd?: number | null;
  };
  first: ServRevisionHttpTrace & { parsed: ServVerdictPayload };
  revised: ServRevisionHttpTrace & { parsed: ServVerdictPayload };
  challenge: ServRevisionHttpTrace;
  /** Evidence ids that were actually in the recorded facts set. */
  allowedEvidenceIds: string[];
  provenance: string;
};

export type LoadedServRevision =
  | { ok: true; recording: ServRevisionRecording; challenge: AgentSecondPassResult }
  | { ok: false; reason: "not_recorded" | "invalid_recording"; detail: string };

function isTrace(value: unknown): value is ServRevisionHttpTrace {
  if (!value || typeof value !== "object") return false;
  const row = value as ServRevisionHttpTrace;
  return (
    Boolean(row.request) &&
    typeof row.request.profile === "string" &&
    typeof row.request.model === "string" &&
    typeof row.request.user === "string" &&
    typeof row.rawResponse === "string" &&
    row.rawResponse.trim().length > 0
  );
}

export function parseServRevisionRecording(raw: unknown): LoadedServRevision {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "invalid_recording", detail: "Recording is not an object." };
  }
  const row = raw as Partial<ServRevisionRecording>;
  if (row.schema !== SERV_REVISION_RECORDING_SCHEMA) {
    return {
      ok: false,
      reason: "invalid_recording",
      detail: `Expected schema ${SERV_REVISION_RECORDING_SCHEMA}.`,
    };
  }
  if (typeof row.recordedAt !== "string" || !row.recordedAt.trim()) {
    return { ok: false, reason: "invalid_recording", detail: "recordedAt missing." };
  }
  if (typeof row.model !== "string" || !row.model.trim()) {
    return { ok: false, reason: "invalid_recording", detail: "model missing." };
  }
  if (typeof row.provenance !== "string" || !/live|record-serv-revision/i.test(row.provenance)) {
    return {
      ok: false,
      reason: "invalid_recording",
      detail: "provenance must name the live recorder (not an agent-written example).",
    };
  }
  if (!isTrace(row.first) || !isTrace(row.revised) || !isTrace(row.challenge)) {
    return { ok: false, reason: "invalid_recording", detail: "first/revised/challenge traces incomplete." };
  }
  const firstParsed = parseServVerdict(row.first.rawResponse) ?? row.first.parsed;
  const revisedParsed = parseServVerdict(row.revised.rawResponse) ?? row.revised.parsed;
  if (!firstParsed || !revisedParsed) {
    return { ok: false, reason: "invalid_recording", detail: "Could not parse first/revised verdict JSON." };
  }
  if (firstParsed.verdict === revisedParsed.verdict) {
    return {
      ok: false,
      reason: "invalid_recording",
      detail: "Revision recording must show a real change between first and revised verdict.",
    };
  }
  const evidence = Array.isArray(row.allowedEvidenceIds)
    ? row.allowedEvidenceIds.filter((id): id is string => typeof id === "string")
    : [];
  if (evidence.length === 0) {
    return { ok: false, reason: "invalid_recording", detail: "allowedEvidenceIds required." };
  }
  const challenge = applyAgentSecondPass({
    primaryAction: revisedParsed.verdict as Exclude<DecisionAction, "withheld">,
    confidence: "high",
    rawText: row.challenge.rawResponse,
    allowedEvidenceIds: new Set(evidence),
  });
  const recording: ServRevisionRecording = {
    schema: SERV_REVISION_RECORDING_SCHEMA,
    recordedAt: row.recordedAt,
    model: row.model,
    costUsd: typeof row.costUsd === "number" ? row.costUsd : null,
    costNote: typeof row.costNote === "string" ? row.costNote : null,
    subject: row.subject ?? {},
    first: { ...row.first, parsed: firstParsed },
    revised: { ...row.revised, parsed: revisedParsed },
    challenge: row.challenge,
    allowedEvidenceIds: evidence,
    provenance: row.provenance,
  };
  return { ok: true, recording, challenge };
}

export function loadServRevisionRecording(
  path = SERV_REVISION_RECORDING_PATH,
): LoadedServRevision {
  if (!existsSync(path)) {
    return {
      ok: false,
      reason: "not_recorded",
      detail: "No live SERV revision recording on disk yet. Run npm run eval:record-serv-revision.",
    };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parseServRevisionRecording(raw);
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_recording",
      detail: error instanceof Error ? error.message : "Failed to read recording.",
    };
  }
}
