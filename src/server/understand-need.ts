import {
  applyFollowUp,
  followUps,
  overlayExplicit,
  supplementNeedFromNote,
  validateNeed,
  type FollowUp,
  type StructuredNeed,
} from "@/domain/need";
import {
  fallbackFindPlan,
  findPlanToServHint,
  planToDirections,
  planToStructuredNeed,
  validateFindPlan,
  type FindPlan,
} from "@/domain/find-plan";
import { buildSearchSpec, type SearchFormEdits, type SearchSpec } from "@/domain/search-spec";
import {
  isUserProvenanced,
  pickUserFormConstraints,
  type ConstraintBag,
} from "@/domain/constraint-provenance";
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
import { extractServJson } from "@/domain/serv-json";
import { plannedProof, type ServProof } from "@/server/serv";
import { callStep } from "@/server/serv/call-step";
import { providerResponseId } from "@/domain/serv-response-id";
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
      /** SearchSpec built with SERV hint — hard/soft owned by the plan. */
      searchSpec: SearchSpec;
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
    /** @deprecated Prefer constraints.priceMaxUsd origin user. */
    budgetDirty?: boolean;
    /** Provenanced form bag — only origin user reaches SearchSpec / SERV as form. */
    constraints?: ConstraintBag | SearchFormEdits | null;
    budgetScope?: StructuredNeed["budgetScope"];
    zip?: string | null;
    distanceMiles?: number | null;
    /** True only when the shopper chose a radius, including Nationwide. A fresh note's null must not wipe a city radius. */
    radiusDirty?: boolean;
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
    /** Ignored. The plan waits for the profile budget. It does not stop early. */
    fastConfirm?: boolean;
  },
  deps: UnderstandDeps,
): Promise<UnderstandResult> {
  const mode = body.mode === "flip" ? "flip" : "personal";
  const text = typeof body.text === "string" ? body.text : "";
  const screened = screenUserInput(text || mode);
  if (!screened.ok) return { ok: false, status: 400, error: "rejected_input", message: screened.reason };

  // Merge legacy *Dirty flags into the provenanced bag, then keep user-origin only.
  const constraintBag: ConstraintBag = { ...(body.constraints ?? {}) };
  if (body.budgetDirty === true && !constraintBag.priceMaxUsd) {
    constraintBag.priceMaxUsd = { value: body.budgetUsd ?? null, origin: "user" };
  }
  if (body.radiusDirty === true && !constraintBag.radiusMi) {
    constraintBag.radiusMi = { value: body.distanceMiles ?? null, origin: "user" };
  }
  // Legacy Confirm geo: radiusDirty + flat zip means the shopper answered ZIP on the form.
  if (
    body.radiusDirty === true &&
    !constraintBag.zip &&
    typeof body.zip === "string" &&
    body.zip.trim()
  ) {
    constraintBag.zip = { value: body.zip.trim(), origin: "user" };
  }
  const userConstraints = pickUserFormConstraints(constraintBag);

  const formBudget = isUserProvenanced(userConstraints.priceMaxUsd)
    ? userConstraints.priceMaxUsd.value
    : null;
  const formOverrides = {
    ...(isUserProvenanced(userConstraints.priceMaxUsd) ? { budgetUsd: formBudget } : {}),
    ...(isUserProvenanced(userConstraints.yearMin) ? { yearMin: userConstraints.yearMin.value } : {}),
    ...(isUserProvenanced(userConstraints.yearMax) ? { yearMax: userConstraints.yearMax.value } : {}),
    ...(isUserProvenanced(userConstraints.milesMax) ? { milesMax: userConstraints.milesMax.value } : {}),
    ...(isUserProvenanced(userConstraints.zip) && userConstraints.zip.value
      ? { zip: userConstraints.zip.value }
      : {}),
  };

  const budgetIsUser = isUserProvenanced(userConstraints.priceMaxUsd);
  const radiusIsUser = isUserProvenanced(userConstraints.radiusMi);

  const explicit: Parameters<typeof overlayExplicit>[1] = {
    mode,
    budgetUsd: formBudget,
    budgetKnown: body.budgetDirty === false && !budgetIsUser ? false : body.budgetKnown,
    budgetDirty: budgetIsUser ? true : body.budgetDirty,
    budgetScope: body.budgetScope,
    zip: isUserProvenanced(userConstraints.zip) ? userConstraints.zip.value : undefined,
    distanceMiles: radiusIsUser ? userConstraints.radiusMi!.value : undefined,
    repairAbility: body.repairAbility,
    useCase: body.useCase,
    targetProfitUsd: body.targetProfitUsd,
    yearMin: isUserProvenanced(userConstraints.yearMin) ? userConstraints.yearMin.value : body.yearMin,
    yearMax: isUserProvenanced(userConstraints.yearMax) ? userConstraints.yearMax.value : body.yearMax,
    yearBandResolved: body.yearBandResolved,
    milesMax: isUserProvenanced(userConstraints.milesMax) ? userConstraints.milesMax.value : body.milesMax,
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
    const validatePlanText = (text: string) => {
      try {
        const validated = validateFindPlan(extractServJson(text), {
          note: screened.text,
          form: formOverrides,
        });
        if (validated.ok) return { ok: true as const };
        return { ok: false as const, issues: validated.issues };
      } catch (err) {
        const message =
          err instanceof Error && err.message.trim()
            ? err.message.trim()
            : "SERV plan answer had no usable JSON";
        return { ok: false as const, issues: [{ field: "plan", message }] };
      }
    };
    const step = await callStep({
      profileId: "find_plan",
      user: userPayload,
      deps: servDeps,
      critical: true,
      validate: validatePlanText,
    });
    const planned = step.result;
    checks.push(planned.proof);
    const usedPlainRetry = step.retried || step.repaired;
    const plainRetryReason = step.repaired
      ? "SERV planned again after the first reply failed validation."
      : step.retried
        ? "SERV planned again on the base model after the first reply could not be used."
        : null;
    // A failed plan does not invent a verdict. The note's own budget and limits
    // still drive one inventory search (never zero queries).

    // prompt_guard on find_plan — treat a completed call as allow unless the runner blocked.
    guard = planned.ok && step.status === "ok" ? "allow" : "unavailable";
    const openservId =
      typeof planned.proof.openserv?.id === "string" ? planned.proof.openserv.id : null;
    const failedResponseId = providerResponseId(openservId);

    if (step.status !== "ok" || !planned.ok) {
      const issueText = step.validationIssues
        ?.slice(0, 4)
        .map((i) => i.message)
        .join("; ");
      let detail: string;
      if (!planned.ok) {
        const classBit = planned.transportErrorClass ? ` (${planned.transportErrorClass})` : "";
        detail = `${planned.error}${classBit}${usedPlainRetry ? ` Retry also failed.` : ""} The note's own limits were used for the search.`;
      } else {
        detail = `SERV plan failed validation (${issueText || "schema mismatch"}). The note's own limits were used for the search.`;
      }
      proofRecords.push(
        buildDecisionProofRecord({
          purpose: "find_plan",
          rubricId: NEED_PARSE_RUBRIC_ID,
          status: !planned.ok ? "error" : "unknown",
          responseId: failedResponseId,
          model: planned.proof.modelReported,
          recordedAt,
          inputs: parseInputs,
          detail,
          rawResponse: planned.ok ? planned.text : null,
        }),
      );
    } else {
      try {
        const parsed = extractServJson(planned.text);
        const validated = validateFindPlan(parsed, { note: screened.text, form: formOverrides });
        if (validated.ok) {
          findPlan = validated.plan;
          source = "model";
          planResponseId = providerResponseIdFromCall({
            ok: planned.ok,
            id: openservId,
          });
          const detailParts = [
            usedPlainRetry && plainRetryReason ? plainRetryReason : null,
            validated.dropped.length > 0 ? `Clamped: ${validated.dropped.slice(0, 8).join(", ")}` : null,
          ].filter(Boolean);
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
              detail: detailParts.length > 0 ? detailParts.join(" · ") : null,
            }),
          );
        } else {
          const issueText = validated.issues
            .slice(0, 4)
            .map((i) => i.message)
            .join("; ");
          proofRecords.push(
            buildDecisionProofRecord({
              purpose: "find_plan",
              rubricId: NEED_PARSE_RUBRIC_ID,
              status: "unknown",
              responseId: failedResponseId,
              model: planned.proof.modelReported,
              recordedAt,
              inputs: parseInputs,
              detail: `SERV plan failed validation (${issueText || "schema mismatch"}). The note's own limits were used for the search.`,
              rawResponse: planned.text,
            }),
          );
        }
      } catch (err) {
        const message =
          err instanceof Error && err.message.trim()
            ? err.message.trim()
            : "SERV plan answer had no usable JSON";
        proofRecords.push(
          buildDecisionProofRecord({
            purpose: "find_plan",
            rubricId: NEED_PARSE_RUBRIC_ID,
            status: "unknown",
            responseId: failedResponseId,
            model: planned.proof.modelReported,
            recordedAt,
            inputs: parseInputs,
            detail: `SERV plan failed validation (${message}). The note's own limits were used for the search.`,
            rawResponse: planned.text,
          }),
        );
      }
    }
  }

  // Success: map plan without regex overlay. Fail/fallback: plan already came from fallbackFindPlan.
  let need = planToStructuredNeed(findPlan, mode, screened.text);
  need = overlayExplicit(need, explicit);
  if (body.followUp) need = applyFollowUp(need, body.followUp.id, body.followUp.value);
  // A limit written in the note stays when the model leaves the field blank.
  need = supplementNeedFromNote(need, screened.text);

  const formZip =
    isUserProvenanced(userConstraints.zip) &&
    typeof userConstraints.zip.value === "string" &&
    /^\d{5}$/.test(userConstraints.zip.value.trim())
      ? userConstraints.zip.value.trim()
      : null;

  // Drop stale wizard ZIP when this note named a city/place without those digits.
  // Keep an explicit Confirm/form ZIP (answers needsZip / "near me").
  {
    const intake = intakeFromNote(screened.text);
    if (
      !formZip &&
      intake.locationPhrase &&
      !intake.zip &&
      need.zip &&
      need.zip !== intake.zip
    ) {
      need = { ...need, zip: null, locationPhrase: need.locationPhrase ?? intake.locationPhrase };
    }
  }
  // City/phrase → ZIP via free table. Default radius is UI suggestion only — never a constraint.
  {
    const withGeo = attachNoteGeo(need, { applyDefaultRadius: false });
    const { locationResolution: _loc, radiusIsDefault: _rad, ...rest } = withGeo;
    need = rest;
  }
  // attachNoteGeo only trusts ZIP digits in the note — re-apply Confirm/form geo after scrub.
  if (formZip) need = { ...need, zip: formZip };
  // Radius reaches need only when the shopper user-edited it (or chose Nationwide).
  if (radiusIsUser) {
    need = { ...need, distanceMiles: userConstraints.radiusMi!.value ?? null };
  }
  // Answered ZIP clears the blocking question for Confirm.
  if (formZip && findPlan.location.needsZip) {
    findPlan = {
      ...findPlan,
      location: { ...findPlan.location, zip: formZip, needsZip: false },
      question: { id: "none", text: null },
    };
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

  // Only user-origin fields become SearchSpec form edits — never stamp note/SERV/suggestion as form.
  const formEditsForSpec: SearchFormEdits = { ...userConstraints };
  const searchSpec = buildSearchSpec({
    note: checked.need.note ?? screened.text,
    mode,
    formEdits: formEditsForSpec,
    servPlan: findPlanToServHint(findPlan),
  });
  if (searchSpec.budgetConflict) {
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "find_plan",
        rubricId: NEED_PARSE_RUBRIC_ID,
        status: "ok",
        responseId: planResponseId,
        model: null,
        recordedAt: new Date().toISOString(),
        inputs: { budgetConflict: searchSpec.budgetConflict },
        detail: searchSpec.budgetConflict.journalLine,
      }),
    );
  }

  return {
    ok: true,
    source,
    need: checked.need,
    findPlan,
    searchSpec,
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
