import {
  applyFollowUp,
  explicitNeedFromText,
  followUps,
  overlayExplicit,
  parseNeedJson,
  validateNeed,
  type FollowUp,
  type StructuredNeed,
} from "@/domain/need";
import { interpretGuard, runServ } from "@/server/serv";
import { screenUserInput } from "@/domain/screen";

export type UnderstandDeps = {
  servKey?: string;
  servModel?: string;
  servBaseUrl?: string;
  fetchImpl?: typeof fetch;
};

export type UnderstandResult =
  | { ok: true; source: "model" | "form"; need: StructuredNeed; followUps: FollowUp[]; guard: string }
  | { ok: false; status: number; error: string; message: string };

export async function understandNeed(
  body: {
    text?: string;
    mode?: "personal" | "flip";
    budgetUsd?: number | null;
    budgetKnown?: boolean;
    budgetScope?: StructuredNeed["budgetScope"];
    zip?: string | null;
    repairAbility?: StructuredNeed["repairAbility"];
    useCase?: StructuredNeed["useCase"];
    targetProfitUsd?: number | null;
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
    repairAbility: body.repairAbility,
    useCase: body.useCase,
    targetProfitUsd: body.targetProfitUsd,
  };

  let source: "model" | "form" = "form";
  let guard = "not_configured";
  let extracted = explicitNeedFromText(screened.text, mode);

  if (deps.servKey) {
    const model = deps.servModel;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const servDeps = { fetch: fetchImpl, apiKey: deps.servKey, baseUrl: deps.servBaseUrl, model };
    const guarded = await runServ("need_guard", { user: screened.text }, servDeps);
    if (!guarded.ok) {
      guard = "unavailable";
    } else {
      guard = interpretGuard(guarded.text);
      if (guard === "block") {
        return { ok: false, status: 400, error: "rejected_input", message: "That note was rejected by the input check." };
      }
      const extractedCall = await runServ("need_extract", { user: screened.text }, servDeps);
      if (extractedCall.ok) {
        try {
          const parsed = validateNeed({ ...(parseNeedJson(extractedCall.text) as object), mode, note: screened.text });
          if (parsed.ok) {
            extracted = parsed.need;
            source = "model";
          }
        } catch {
          source = "form";
        }
      }
    }
  }

  let need = overlayExplicit(extracted, explicit);
  if (body.followUp) need = applyFollowUp(need, body.followUp.id, body.followUp.value);
  const checked = validateNeed(need);
  if (!checked.ok) return { ok: false, status: 400, error: "invalid_need", message: checked.issues[0]?.message ?? "That need is not usable." };
  return { ok: true, source, need: checked.need, followUps: followUps(checked.need), guard };
}
