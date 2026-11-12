/**
 * HTTP behavior for /api/run. Routes stay thin; tests call these with a real Kv.
 */
import { isFailureReasonId, isVerdictId, type RunKind } from "@/domain/buyer-copy-table";
import { appendClarification, createRun, isRunId, toRunView, type RunRecord } from "@/domain/run";
import type { SearchFormEdits } from "@/domain/search-spec";
import { fromShopperInputEvent, type ConstraintFieldKey } from "@/domain/constraint-provenance";
import type { RunView } from "@/domain/run-view";
import type { Kv } from "@/io/kv";
import { insertRun, readRun, updateRun } from "@/io/run-store";

export type RunHttpResult = { status: number; body: Record<string, unknown> };

const KINDS = new Set<RunKind>(["find", "resale", "check"]);

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function readKind(value: unknown): RunKind | null {
  return value === "find" || value === "resale" || value === "check" ? value : null;
}

function readFormEdits(value: unknown): SearchFormEdits | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const out: SearchFormEdits = {};
  const numeric = ["priceMaxUsd", "yearMin", "yearMax", "milesMax", "radiusMi"] as const;
  for (const key of numeric) {
    const cell = row[key];
    if (!cell || typeof cell !== "object" || Array.isArray(cell)) continue;
    const rec = cell as { value?: unknown; dirty?: unknown; origin?: unknown };
    const kind = rec.origin === "user" ? "wire" : rec.dirty === true ? "legacy_dirty" : null;
    if (!kind) continue;
    const field = key as ConstraintFieldKey;
    if (rec.value === null) {
      out[key] = fromShopperInputEvent({ kind, field, value: null });
      continue;
    }
    if (typeof rec.value === "number" && Number.isFinite(rec.value)) {
      out[key] = fromShopperInputEvent({ kind, field, value: Math.round(rec.value) });
    }
  }
  const zip = row.zip;
  if (zip && typeof zip === "object" && !Array.isArray(zip)) {
    const rec = zip as { value?: unknown; dirty?: unknown; origin?: unknown };
    const kind = rec.origin === "user" ? "wire" : rec.dirty === true ? "legacy_dirty" : null;
    if (kind && (rec.value === null || typeof rec.value === "string")) {
      out.zip = fromShopperInputEvent({
        kind,
        field: "zip",
        value: typeof rec.value === "string" ? rec.value : null,
      });
    }
  }
  return out;
}

function viewBody(run: RunRecord, viewerId: string | null): { run: RunView } {
  return { run: toRunView(run, viewerId) };
}

export async function createRunRequest(kv: Kv, ownerId: string, body: unknown): Promise<RunHttpResult> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid_json", message: "Send the note for this search." } };
  }
  const row = body as Record<string, unknown>;
  if (["verdict", "creditsCharged", "steps", "spec", "picks", "listings"].some((key) => key in row)) {
    return { status: 400, body: { error: "client_decision", message: "The search result is stored by the server." } };
  }
  const kind = readKind(row.kind);
  if (!kind || !KINDS.has(kind)) {
    return { status: 400, body: { error: "invalid_kind", message: "Say whether this is a find, a resale search, or a vehicle check." } };
  }
  const note = cleanText(row.note, 4000);
  const vin = cleanText(row.vin, 17).toUpperCase() || null;
  if (kind !== "check" && note.length < 2 && !vin) {
    return { status: 400, body: { error: "missing_note", message: "Write what you are looking for." } };
  }
  const clarifications = Array.isArray(row.clarifications)
    ? row.clarifications.map((line) => cleanText(line, 500)).filter(Boolean).slice(0, 8)
    : [];
  const mode = row.mode === "flip" || kind === "resale" ? "flip" : "personal";
  let record = createRun({
    ownerId,
    kind,
    inputs: {
      note,
      clarifications,
      mode,
      vin,
      formEdits: readFormEdits(row.formEdits),
    },
  });
  const inserted = await insertRun(kv, record);
  if (!inserted) {
    record = createRun({
      ownerId,
      kind,
      inputs: record.inputs,
    });
    const retry = await insertRun(kv, record);
    if (!retry) return { status: 503, body: { error: "store_busy", message: "The search could not be saved. Try again." } };
  }
  return { status: 201, body: viewBody(record, ownerId) };
}

export async function getRunRequest(kv: Kv, id: string, viewerId: string | null): Promise<RunHttpResult> {
  if (!isRunId(id)) return { status: 404, body: { error: "not_found", message: "That search does not exist." } };
  const run = await readRun(kv, id);
  if (!run) return { status: 404, body: { error: "not_found", message: "That search does not exist." } };
  return { status: 200, body: viewBody(run, viewerId) };
}

export async function patchRunRequest(kv: Kv, id: string, ownerId: string, body: unknown): Promise<RunHttpResult> {
  if (!isRunId(id)) return { status: 404, body: { error: "not_found", message: "That search does not exist." } };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid_json", message: "Send the detail you want to add." } };
  }
  const row = body as Record<string, unknown>;
  if (["verdict", "creditsCharged", "steps", "spec", "picks", "listings", "failureReasons", "confidence"].some((key) => key in row)) {
    return { status: 400, body: { error: "client_decision", message: "The search result is stored by the server." } };
  }
  if ("verdict" in row && typeof row.verdict === "string" && isVerdictId(row.verdict)) {
    return { status: 400, body: { error: "client_decision", message: "The search result is stored by the server." } };
  }
  if ("failureReasons" in row && Array.isArray(row.failureReasons) && row.failureReasons.every((item) => typeof item === "string" && isFailureReasonId(item))) {
    return { status: 400, body: { error: "client_decision", message: "The search result is stored by the server." } };
  }
  const clarification = cleanText(row.clarification, 500);
  const formEdits = readFormEdits(row.formEdits);
  if (!clarification && !formEdits) {
    return { status: 400, body: { error: "missing_detail", message: "Add a detail or a limit you changed." } };
  }
  const existing = await readRun(kv, id);
  if (!existing) return { status: 404, body: { error: "not_found", message: "That search does not exist." } };
  if (existing.ownerId !== ownerId) {
    return { status: 403, body: { error: "forbidden", message: "Only the person who ran this search can change it." } };
  }
  const next = await updateRun(kv, id, (current) => appendClarification(current, clarification, formEdits));
  if (!next) return { status: 503, body: { error: "store_busy", message: "The search could not be saved. Try again." } };
  return { status: 200, body: viewBody(next, ownerId) };
}
