import { randomUUID } from "node:crypto";
import { auditExplanation } from "@/domain/audit";
import { haversineMiles } from "@/domain/geo";
import { sha256Canonical } from "@/domain/hash";
import { buildComputedReport } from "@/domain/report";
import { screenUserInput } from "@/domain/screen";
import { templateExplanation } from "@/domain/template";
import { extractVin } from "@/domain/vin";
import type { FullReport, Listing, Mode, Proof, ProofStep } from "@/domain/types";
import { autodevByVin, autodevSearch, type AutodevDeps } from "@/io/autodev";
import { complaintCountFor, decodeVin, fuelFor, geocodeZipCity, recallsFor, type GovDeps } from "@/io/gov";
import { sampleByVin, sampleListings } from "@/io/sample";
import {
  buildExplainRequest,
  buildGuardRequest,
  EXPLAIN_PROMPT_VERSION,
  GUARD_PROMPT_VERSION,
  interpretGuard,
  postServ,
  SHADOW_HINT,
  SHADOW_MAX_ITERATIONS,
} from "@/io/serv";

export type AssembleInput = {
  mode: Mode;
  vin?: string;
  url?: string;
  make?: string;
  model?: string;
  zip?: string;
  year?: number;
};

export type AssembleDeps = {
  autodevKey?: string;
  servKey?: string;
  servModel?: string;
  servBaseUrl?: string;
  fetch?: typeof fetch;
  autodev?: Pick<AutodevDeps, "cache" | "counter">;
  now?: Date;
};

export type AssembleResult =
  | { ok: true; report: FullReport }
  | { ok: false; status: number; error: string; message: string };

function factsOf(report: FullReport["computed"]) {
  return {
    verdict: report.verdict,
    mode: report.mode,
    sample: report.sample,
    subject: {
      vin: report.subject.vin,
      year: report.subject.year,
      make: report.subject.make,
      model: report.subject.model,
      trim: report.subject.trim,
      miles: report.subject.miles,
      priceUsd: report.subject.priceUsd,
      city: report.subject.city,
      state: report.subject.state,
      accidentCount: report.subject.accidentCount,
      ownerCount: report.subject.ownerCount,
      oneOwner: report.subject.oneOwner,
      usageType: report.subject.usageType,
      cpo: report.subject.cpo,
    },
    fairValueUsd: report.fairValueUsd,
    priceGap: report.priceGap,
    percentile: report.percentile,
    compCount: report.comps.length,
    comps: report.comps.map((comp) => ({
      vin: comp.vin,
      priceUsd: comp.priceUsd,
      adjustedPriceUsd: comp.adjustedPriceUsd,
      miles: comp.miles,
    })),
    reasons: report.reasons,
    dataNotes: report.dataNotes,
    recalls: report.recalls.map((recall) => ({
      campaignNumber: recall.campaignNumber,
      component: recall.component,
      parkIt: recall.parkIt,
      parkOutSide: recall.parkOutSide,
    })),
    complaintCount: report.complaintCount,
    fuel: report.fuel,
    flip: report.flip,
    historyLines: report.history.lines,
  };
}

export async function assembleReport(input: AssembleInput, deps: AssembleDeps): Promise<AssembleResult> {
  const steps: ProofStep[] = [];
  const lookupText = [input.url, input.vin, input.make, input.model, input.zip, input.year?.toString()]
    .filter(Boolean)
    .join(" ");
  const screened = screenUserInput(lookupText || "");
  if (!screened.ok) {
    return { ok: false, status: 400, error: "rejected_input", message: screened.reason };
  }
  steps.push({ id: "local_input_screen", status: "passed" });

  const vin = extractVin(input.vin || input.url || "");
  if (!vin) {
    return {
      ok: false,
      status: 400,
      error: "vin_required",
      message: "A full report needs one vehicle. Paste a listing URL that contains a VIN, or choose a car from Deal Radar.",
    };
  }

  const fetchImpl = deps.fetch ?? fetch;
  const model = deps.servModel || process.env.SERV_MODEL || "gpt-5.4-mini";
  const baseUrl = deps.servBaseUrl || process.env.SERV_BASE_URL || "https://inference-api.openserv.ai/v1";

  if (!deps.servKey) {
    steps.push({
      id: "serv_prompt_guard",
      status: "skipped",
      detail: "SERV_API_KEY is not set. The local screen still ran. The written summary is the template.",
    });
  } else {
    const guard = await postServ(buildGuardRequest(screened.text, model), {
      fetch: fetchImpl,
      apiKey: deps.servKey,
      baseUrl,
    });
    if (!guard.ok) {
      steps.push({ id: "serv_prompt_guard", status: "error", detail: guard.error });
      return {
        ok: false,
        status: 503,
        error: "serv_unavailable",
        message: "The input check could not be completed, so this request was not run.",
      };
    }
    const decision = interpretGuard(guard.text);
    steps.push({ id: "serv_prompt_guard", status: decision, detail: GUARD_PROMPT_VERSION });
    if (decision === "block") {
      return {
        ok: false,
        status: 400,
        error: "rejected_input",
        message: "That input was rejected by the input check.",
      };
    }
  }

  const resolved = await resolveSubject(vin, input, deps, fetchImpl);
  if (!resolved.ok) return resolved.result;
  steps.push({
    id: "listings",
    status: resolved.sample ? "sample" : "autodev",
    detail: resolved.cached ? "cache hit" : "fetched",
  });

  const gov: GovDeps = { fetch: fetchImpl };
  const [vinDecode, recalls, complaintCount, fuel, distance] = await Promise.all([
    decodeVin(vin, gov),
    recallsFor(resolved.subject.make, resolved.subject.model, resolved.subject.year, gov),
    complaintCountFor(resolved.subject.make, resolved.subject.model, resolved.subject.year, gov),
    fuelFor(resolved.subject.year, resolved.subject.make, resolved.subject.model, resolved.subject.engine, gov),
    distanceBetween(resolved.subject, input.zip, gov),
  ]);
  steps.push({
    id: "government_data",
    status: "ran",
    detail: "NHTSA vPIC, NHTSA recalls, NHTSA complaints, fueleconomy.gov, US Census geocoder",
  });

  const computed = buildComputedReport({
    mode: input.mode,
    subject: resolved.subject,
    candidates: resolved.candidates,
    recalls,
    complaintCount,
    fuel,
    vinDecode,
    distanceToSearchZipMiles: distance,
    asOfYear: (deps.now ?? new Date()).getUTCFullYear(),
    sample: resolved.sample,
  });
  steps.push({
    id: "deterministic_tools",
    status: "ran",
    detail:
      "selectComparables, mileageAdjust, historyAdjustment, verdictFromPriceGap, flipMath, scoreFromGap, dealerQuestions",
  });

  let explanation = templateExplanation(computed);
  let explanationSource: Proof["explanationSource"] = "template";
  let usedModel: string | null = null;
  const shadow = {
    requested: false,
    hint: SHADOW_HINT,
    maxIterations: SHADOW_MAX_ITERATIONS,
    outcome: deps.servKey ? "not_called" : "skipped_no_key",
  };

  if (deps.servKey) {
    shadow.requested = true;
    const explained = await postServ(buildExplainRequest(factsOf(computed), screened.text, model), {
      fetch: fetchImpl,
      apiKey: deps.servKey,
      baseUrl,
    });
    if (!explained.ok) {
      shadow.outcome = "error";
      steps.push({ id: "serv_shadow_agent", status: "fallback_template", detail: explained.error });
    } else {
      shadow.outcome = explained.shadowOutcome;
      usedModel = explained.model;
      const audit = auditExplanation(explained.text, computed);
      const shadowFailed = explained.shadowOutcome === "exhausted" || explained.shadowOutcome === "failed";
      if (audit.ok && !shadowFailed) {
        explanation = explained.text;
        explanationSource = "serv";
        steps.push({ id: "serv_shadow_agent", status: explained.shadowOutcome, detail: EXPLAIN_PROMPT_VERSION });
        steps.push({ id: "number_audit", status: "passed" });
      } else {
        steps.push({
          id: "serv_shadow_agent",
          status: "fallback_template",
          detail: shadowFailed ? explained.shadowOutcome : "number audit failed",
        });
        steps.push({
          id: "number_audit",
          status: audit.ok ? "passed_but_shadow_failed" : "failed",
          detail: audit.ok ? undefined : audit.offenders.slice(0, 8).join(", "),
        });
      }
    }
  } else {
    steps.push({ id: "serv_shadow_agent", status: "skipped", detail: "SERV_API_KEY is not set." });
    steps.push({ id: "number_audit", status: "template" });
  }

  const proof: Proof = {
    version: "autoflip.proof.v1",
    inputsHash: sha256Canonical({
      mode: input.mode,
      vin,
      zip: input.zip ?? null,
      subject: resolved.subject.vin,
      compVins: computed.comps.map((comp) => comp.vin).sort(),
      fairValueUsd: computed.fairValueUsd,
      verdict: computed.verdict,
    }),
    model: usedModel,
    promptVersion: EXPLAIN_PROMPT_VERSION,
    steps,
    toolOutputs: {
      verdict: computed.verdict,
      fairValueUsd: computed.fairValueUsd,
      priceGap: computed.priceGap,
      percentile: computed.percentile,
      compCount: computed.comps.length,
      score: computed.score,
      flip: computed.flip,
      recallCount: computed.recalls.length,
      openParkIt: computed.openParkIt,
      complaintCount: computed.complaintCount,
      fuel: computed.fuel,
    },
    explanationSource,
    shadow,
  };

  const report: FullReport = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    explanation,
    computed,
    proof,
  };
  return { ok: true, report };
}

async function distanceBetween(subject: Listing, zip: string | undefined, gov: GovDeps): Promise<number | null> {
  if (!zip || !subject.zip) return null;
  const [from, to] = await Promise.all([
    geocodeZipCity({ zip, city: null, state: null }, gov),
    geocodeZipCity({ zip: subject.zip, city: subject.city, state: subject.state }, gov),
  ]);
  if (!from || !to) return null;
  return Math.round(haversineMiles(from, to));
}

async function resolveSubject(
  vin: string,
  input: AssembleInput,
  deps: AssembleDeps,
  fetchImpl: typeof fetch,
): Promise<
  | { ok: true; subject: Listing; candidates: Listing[]; sample: boolean; cached: boolean }
  | { ok: false; result: AssembleResult }
> {
  if (!deps.autodevKey || !deps.autodev) {
    const subject = sampleByVin(vin);
    if (!subject) {
      return {
        ok: false,
        result: {
          ok: false,
          status: 404,
          error: "not_in_sample",
          message:
            "That VIN is not in the labeled sample set, and no listings key is configured. The sample is five Toyota Camry listings.",
        },
      };
    }
    return { ok: true, subject, candidates: sampleListings(), sample: true, cached: false };
  }

  const byVin = await autodevByVin(vin, {
    fetch: fetchImpl,
    cache: deps.autodev.cache,
    counter: deps.autodev.counter,
    apiKey: deps.autodevKey,
    now: deps.now,
  });
  if (!byVin.ok) {
    const status = byVin.error === "demo_limit" ? 429 : byVin.status === 404 ? 404 : 502;
    return {
      ok: false,
      result: {
        ok: false,
        status,
        error: byVin.error === "demo_limit" ? "demo_limit" : "listings_error",
        message: byVin.message,
      },
    };
  }
  const subject = byVin.listings[0];
  if (!subject) {
    return {
      ok: false,
      result: {
        ok: false,
        status: 404,
        error: "not_found",
        message: "The listings provider did not return a vehicle for that VIN.",
      },
    };
  }
  const search = await autodevSearch(
    {
      make: subject.make,
      model: subject.model,
      year: input.year ?? subject.year,
      zip: input.zip || subject.zip || undefined,
      distanceMiles: input.zip || subject.zip ? 500 : undefined,
      limit: 20,
    },
    {
      fetch: fetchImpl,
      cache: deps.autodev.cache,
      counter: deps.autodev.counter,
      apiKey: deps.autodevKey,
      now: deps.now,
    },
  );
  if (!search.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        status: search.error === "demo_limit" ? 429 : 502,
        error: search.error === "demo_limit" ? "demo_limit" : "listings_error",
        message: search.message,
      },
    };
  }
  const candidates = search.listings.some((item) => item.vin === subject.vin)
    ? search.listings
    : [subject, ...search.listings];
  return {
    ok: true,
    subject,
    candidates,
    sample: false,
    cached: byVin.cached && search.cached,
  };
}

export async function assembleRadar(
  input: { make: string; model: string; zip?: string; year?: number; distanceMiles?: number; mode: Mode },
  deps: AssembleDeps,
): Promise<
  | { ok: true; listings: Listing[]; sample: boolean; message: string | null }
  | { ok: false; status: number; error: string; message: string }
> {
  const screened = screenUserInput([input.make, input.model, input.zip, input.year?.toString()].filter(Boolean).join(" "));
  if (!screened.ok) return { ok: false, status: 400, error: "rejected_input", message: screened.reason };
  if (deps.servKey) {
    const model = deps.servModel || process.env.SERV_MODEL || "gpt-5.4-mini";
    const baseUrl = deps.servBaseUrl || process.env.SERV_BASE_URL || "https://inference-api.openserv.ai/v1";
    const guard = await postServ(buildGuardRequest(screened.text, model), {
      fetch: deps.fetch ?? fetch,
      apiKey: deps.servKey,
      baseUrl,
    });
    if (!guard.ok || interpretGuard(guard.text) === "block") {
      return {
        ok: false,
        status: guard.ok ? 400 : 503,
        error: guard.ok ? "rejected_input" : "serv_unavailable",
        message: guard.ok
          ? "That input was rejected by the input check."
          : "The input check could not be completed, so this request was not run.",
      };
    }
  }
  if (!input.make.trim() || !input.model.trim()) {
    return { ok: false, status: 400, error: "make_model_required", message: "Enter a make and a model." };
  }
  if (!deps.autodevKey || !deps.autodev) {
    return {
      ok: true,
      listings: sampleListings(),
      sample: true,
      message:
        "No listings key is configured. These five Toyota Camry rows are the labeled sample fixture. They are not the result of your search.",
    };
  }
  const fetchImpl = deps.fetch ?? fetch;
  const search = await autodevSearch(
    {
      make: input.make.trim(),
      model: input.model.trim(),
      year: input.year,
      zip: input.zip,
      distanceMiles: input.distanceMiles ?? (input.zip ? 100 : undefined),
      limit: 20,
    },
    {
      fetch: fetchImpl,
      cache: deps.autodev.cache,
      counter: deps.autodev.counter,
      apiKey: deps.autodevKey,
      now: deps.now,
    },
  );
  if (!search.ok) {
    return {
      ok: false,
      status: search.error === "demo_limit" ? 429 : 502,
      error: search.error === "demo_limit" ? "demo_limit" : "listings_error",
      message: search.message,
    };
  }
  return {
    ok: true,
    listings: search.listings,
    sample: false,
    message: search.listings.length === 0 ? "No listings came back for that search." : null,
  };
}
