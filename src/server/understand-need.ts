import {
  applyFollowUp,
  followUps,
  overlayExplicit,
  parseNeedJson,
  validateNeed,
  type FollowUp,
  type StructuredNeed,
} from "@/domain/need";
import {
  fallbackFindPlan,
  planToDirections,
  planToStructuredNeed,
  validateFindPlan,
  type FindPlan,
} from "@/domain/find-plan";
import type { SearchDirection } from "@/domain/directions";
import { attachNoteGeo } from "@/domain/find-intake-stage";
import { intakeFromNote } from "@/domain/note-intake";
import type { DecisionProof } from "@/domain/decision-note";
import {
  buildDecisionProofRecord,
  NEED_PARSE_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";
import type { CriteriaParseProvenance } from "@/domain/radar-criteria-provenance";
import { criteriaParseLabel } from "@/domain/radar-criteria-provenance";
import { providerResponseIdFromCall } from "@/domain/serv-response-id";
import { plannedProof, runServ, type ServProof } from "@/server/serv";
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
      /** Validated C1 plan (SERV or offline fallback). */
      findPlan: FindPlan;
      /** Search directions from the plan (never empty for a valid note). */
      directions: SearchDirection[];
      followUps: FollowUp[];
      guard: string;
      checks: DecisionProof[];
      /** Honest provenance for free-text → structured criteria (Watch with Deal Radar). */
      criteriaParse: CriteriaParseProvenance & { label: string };
      /** One proof record for find_plan (or honest skip). */
      proofRecords: DecisionProofRecord[];
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

  const formOverrides = {
    budgetUsd: body.budgetUsd ?? null,
    yearMin: body.yearMin ?? null,
    yearMax: body.yearMax ?? null,
    milesMax: body.milesMax ?? null,
    zip: body.zip ?? null,
  };

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
  let findPlan: FindPlan = fallbackFindPlan(screened.text, mode, formOverrides);
  const checks: ServProof[] = [];
  const proofRecords: DecisionProofRecord[] = [];
  const recordedAt = new Date().toISOString();
  const parseInputs = { text: screened.text, mode };
  let planResponseId: string | null = null;

  if (!screened.text.trim()) {
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "find_plan",
        rubricId: NEED_PARSE_RUBRIC_ID,
        status: "skipped_no_evidence",
        recordedAt,
        inputs: parseInputs,
        detail: "No free-text need to parse.",
      }),
    );
  } else if (!deps.servKey) {
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "find_plan",
        rubricId: NEED_PARSE_RUBRIC_ID,
        status: "skipped_no_key",
        recordedAt,
        inputs: parseInputs,
        detail: "SERV_API_KEY is not configured — local find_plan fallback only.",
      }),
    );
  } else {
    const model = deps.servModel;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const servDeps = { fetch: fetchImpl, apiKey: deps.servKey, baseUrl: deps.servBaseUrl, model };
    const userPayload = JSON.stringify({
      note: screened.text,
      mode,
      formOverrides,
      today: recordedAt.slice(0, 10),
    });
    const planned = await runServ("find_plan", { user: userPayload }, servDeps);
    checks.push(planned.proof);
    // prompt_guard on find_plan — treat a completed call as allow unless the runner blocked.
    guard = planned.ok ? "allow" : "unavailable";

    if (!planned.ok) {
      proofRecords.push(
        buildDecisionProofRecord({
          purpose: "find_plan",
          rubricId: NEED_PARSE_RUBRIC_ID,
          status: "error",
          model: planned.proof.modelReported,
          recordedAt,
          inputs: parseInputs,
          detail: planned.error,
          rawResponse: null,
        }),
      );
      findPlan = fallbackFindPlan(screened.text, mode, formOverrides);
      source = "form";
    } else {
      try {
        const parsed = parseNeedJson(planned.text);
        const validated = validateFindPlan(parsed, { note: screened.text, form: formOverrides });
        if (validated.ok) {
          findPlan = validated.plan;
          source = "model";
          planResponseId = providerResponseIdFromCall({
            ok: planned.ok,
            id: planned.proof.openserv?.id ?? null,
          });
          proofRecords.push(
            buildDecisionProofRecord({
              purpose: "find_plan",
              rubricId: NEED_PARSE_RUBRIC_ID,
              status: "ok",
              responseId: planResponseId,
              model: planned.proof.modelReported,
              recordedAt,
              inputs: parseInputs,
              verdict: "planned",
              rawResponse: planned.text,
              detail:
                validated.dropped.length > 0
                  ? `Clamped: ${validated.dropped.slice(0, 8).join(", ")}`
                  : null,
            }),
          );
        } else {
          findPlan = fallbackFindPlan(screened.text, mode, formOverrides);
          source = "form";
          proofRecords.push(
            buildDecisionProofRecord({
              purpose: "find_plan",
              rubricId: NEED_PARSE_RUBRIC_ID,
              status: "unknown",
              model: planned.proof.modelReported,
              recordedAt,
              inputs: parseInputs,
              detail: validated.issues[0]?.message ?? "find_plan failed validation.",
              rawResponse: planned.text,
            }),
          );
        }
      } catch {
        findPlan = fallbackFindPlan(screened.text, mode, formOverrides);
        source = "form";
        proofRecords.push(
          buildDecisionProofRecord({
            purpose: "find_plan",
            rubricId: NEED_PARSE_RUBRIC_ID,
            status: "unknown",
            model: planned.proof.modelReported,
            recordedAt,
            inputs: parseInputs,
            detail: "find_plan response was unparseable.",
            rawResponse: planned.text || null,
          }),
        );
      }
    }
  }

  // Success: map plan without regex overlay. Fail/fallback: plan already came from fallbackFindPlan.
  let need = planToStructuredNeed(findPlan, mode, screened.text);
  need = overlayExplicit(need, explicit);
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
  if (!checked.ok) {
    return { ok: false, status: 400, error: "invalid_need", message: checked.issues[0]?.message ?? "That need is not usable." };
  }

  const recorded = checks.length > 0 ? checks : [plannedProof("find_plan")];
  const criteriaParse: CriteriaParseProvenance =
    source === "model"
      ? { source: "serv", responseId: planResponseId }
      : screened.text.trim()
        ? { source: "code", responseId: null }
        : { source: "form", responseId: null };

  return {
    ok: true,
    source,
    need: checked.need,
    findPlan,
    directions: planToDirections(findPlan),
    followUps: followUps(checked.need),
    guard,
    checks: recorded.map(publicCheck),
    criteriaParse: { ...criteriaParse, label: criteriaParseLabel(criteriaParse) },
    proofRecords,
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
