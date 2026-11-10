import {
  applyFollowUp,
  budgetFromText,
  explicitNeedFromText,
  followUps,
  makesFromText,
  milesFromText,
  preferOpenToOtherMakes,
  overlayExplicit,
  preferredModelsFromText,
  parseNeedJson,
  supplementNeedFromNote,
  validateNeed,
  type FollowUp,
  type StructuredNeed,
} from "@/domain/need";
import { attachNoteGeo } from "@/domain/find-intake-stage";
import { intakeFromNote } from "@/domain/note-intake";
import type { DecisionProof } from "@/domain/decision-note";
import type { CriteriaParseProvenance } from "@/domain/radar-criteria-provenance";
import { criteriaParseLabel } from "@/domain/radar-criteria-provenance";
import { providerResponseIdFromCall } from "@/domain/serv-response-id";
import { interpretGuard, plannedProof, runServ, type ServProof } from "@/server/serv";
import { screenUserInput } from "@/domain/screen";

export type UnderstandDeps = {
  servKey?: string;
  servModel?: string;
  servBaseUrl?: string;
  fetchImpl?: typeof fetch;
};

export type UnderstandResult =
  | {
      ok: true;
      source: "model" | "form";
      need: StructuredNeed;
      followUps: FollowUp[];
      guard: string;
      checks: DecisionProof[];
      /** Honest provenance for free-text → structured criteria (Watch with Deal Radar). */
      criteriaParse: CriteriaParseProvenance & { label: string };
    }
  | { ok: false; status: number; error: string; message: string };

export async function understandNeed(
  body: {
    text?: string;
    mode?: "personal" | "flip";
    budgetUsd?: number | null;
    budgetKnown?: boolean;
    budgetScope?: StructuredNeed["budgetScope"];
    zip?: string | null;
    distanceMiles?: number | null;
    repairAbility?: StructuredNeed["repairAbility"];
    useCase?: StructuredNeed["useCase"];
    targetProfitUsd?: number | null;
    yearMin?: number | null;
    yearMax?: number | null;
    yearBandResolved?: boolean;
    milesMax?: number | null;
    milesCapResolved?: boolean;
    conditionPriority?: StructuredNeed["conditionPriority"];
    followUp?: { id: FollowUp["id"]; value: string };
  },
  deps: UnderstandDeps,
): Promise<UnderstandResult> {
  const mode = body.mode === "flip" ? "flip" : "personal";
  const text = typeof body.text === "string" ? body.text : "";
  const screened = screenUserInput(text || mode);
  if (!screened.ok) return { ok: false, status: 400, error: "rejected_input", message: screened.reason };

  const explicit: Parameters<typeof overlayExplicit>[1] = {
    mode,
    budgetUsd: body.budgetUsd ?? null,
    budgetKnown: body.budgetKnown,
    budgetScope: body.budgetScope,
    zip: body.zip,
    distanceMiles: body.distanceMiles,
    repairAbility: body.repairAbility,
    useCase: body.useCase,
    targetProfitUsd: body.targetProfitUsd,
    // Preserve prior clarification resolutions across sequential /api/need follow-up posts.
    yearMin: body.yearMin,
    yearMax: body.yearMax,
    yearBandResolved: body.yearBandResolved,
    milesMax: body.milesMax,
    milesCapResolved: body.milesCapResolved,
    conditionPriority: body.conditionPriority,
  };

  let source: "model" | "form" = "form";
  let guard = "not_configured";
  let extracted = explicitNeedFromText(screened.text, mode);
  const checks: ServProof[] = [];
  let extractResponseId: string | null = null;

  if (deps.servKey) {
    const model = deps.servModel;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const servDeps = { fetch: fetchImpl, apiKey: deps.servKey, baseUrl: deps.servBaseUrl, model };
    const guarded = await runServ("need_guard", { user: screened.text }, servDeps);
    checks.push(guarded.proof);
    if (!guarded.ok) {
      guard = "unavailable";
    } else {
      guard = interpretGuard(guarded.text);
    }
    if (guard !== "block") {
      const extractedCall = await runServ("need_extract", { user: screened.text }, servDeps);
      checks.push(extractedCall.proof);
      if (extractedCall.ok) {
        try {
          const parsed = validateNeed({ ...(parseNeedJson(extractedCall.text) as object), mode, note: screened.text });
          if (parsed.ok) {
            extracted = parsed.need;
            source = "model";
            extractResponseId = providerResponseIdFromCall({
              ok: extractedCall.ok,
              id: extractedCall.proof.openserv?.id ?? null,
            });
          }
        } catch {
          source = "form";
        }
      }
    }
  }

  let need = overlayExplicit(extracted, explicit);
  const preferredMakes = makesFromText(need.note);
  const preferredModels = preferredModelsFromText(need.note);
  const openToOtherMakes = preferOpenToOtherMakes(need.note, preferredMakes.length ? preferredMakes : need.preferredMakes);
  // Text-extracted models are user-named. SERV-only suggestions keep service provenance —
  // never label them “Models you named”.
  const fromNote = preferredModels.length > 0;
  const fromService = !fromNote && (need.preferredModels?.length ?? 0) > 0;
  // SERV extract can drop a note budget; re-assert dollars the shopper actually wrote
  // when form/SERV left budget unknown. Never override a different hard max the form set.
  const noteBudget = budgetFromText(screened.text);
  need = {
    ...need,
    milesMax: milesFromText(need.note) ?? need.milesMax,
    preferredMakes: preferredMakes.length ? preferredMakes : need.preferredMakes,
    preferredModels: fromNote ? preferredModels : need.preferredModels,
    preferredModelsSource: fromNote ? "user_note" : fromService ? "service" : "none",
    openToOtherMakes,
    make: (preferredMakes.length ? preferredMakes : need.preferredMakes)[0] ?? need.make,
    ...(noteBudget != null && (!need.budgetKnown || need.budgetUsd == null)
      ? { budgetUsd: noteBudget, budgetKnown: true }
      : {}),
  };
  need = supplementNeedFromNote(need, screened.text);
  if (body.followUp) need = applyFollowUp(need, body.followUp.id, body.followUp.value);
  // Drop stale wizard ZIP when this note named a city/place without those digits.
  {
    const intake = intakeFromNote(screened.text);
    if (intake.locationPhrase && !intake.zip && need.zip && need.zip !== intake.zip) {
      need = { ...need, zip: null, locationPhrase: need.locationPhrase ?? intake.locationPhrase };
    }
  }
  // City/phrase → ZIP via free table; labelled default radius when city given without miles.
  {
    const withGeo = attachNoteGeo(need, { applyDefaultRadius: true });
    const { locationResolution: _loc, radiusIsDefault: _rad, ...rest } = withGeo;
    need = rest;
  }
  const checked = validateNeed(need);
  if (!checked.ok) return { ok: false, status: 400, error: "invalid_need", message: checked.issues[0]?.message ?? "That need is not usable." };
  const recorded = checks.length > 0 ? checks : [plannedProof("need_guard"), plannedProof("need_extract")];
  const criteriaParse: CriteriaParseProvenance =
    source === "model"
      ? { source: "serv", responseId: extractResponseId }
      : screened.text.trim()
        ? { source: "code", responseId: null }
        : { source: "form", responseId: null };
  return {
    ok: true,
    source,
    need: checked.need,
    followUps: followUps(checked.need),
    guard,
    checks: recorded.map(publicCheck),
    criteriaParse: { ...criteriaParse, label: criteriaParseLabel(criteriaParse) },
  };
}

function publicCheck(proof: ServProof): DecisionProof {
  return {
    purpose: proof.purpose,
    tools: proof.tools,
    features: proof.features,
    promptGuard: proof.promptGuard,
    shadowOutcome: proof.shadowOutcome,
    shadowMaxIterations: proof.shadowMaxIterations,
    latencyMs: proof.latencyMs,
    jsonSchema: proof.jsonSchema,
    applicationTool: proof.applicationTool,
    fallbackUsed: proof.fallbackUsed,
    codeComputed: proof.codeComputed,
  };
}
