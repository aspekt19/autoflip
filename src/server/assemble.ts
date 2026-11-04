import { randomUUID } from "node:crypto";
import { auditExplanation } from "@/domain/audit";
import { quotedNumbersStayIn } from "@/domain/decision-note";
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
  EXPLAIN_PROMPT_VERSION,
  GUARD_PROMPT_VERSION,
  SHADOW_HINT,
  SHADOW_MAX_ITERATIONS,
} from "@/io/serv";
import { agentProof, interpretGuard, plannedProof, runServ, type AgentProof, type ProfileId, type ServProof } from "@/server/serv";

export type AssembleInput = {
  mode: Mode;
  vin?: string;
  url?: string;
  make?: string;
  model?: string;
  zip?: string;
  year?: number;
  /** Typed by the shopper when the lookup is a VIN, which has no asking price of its own. */
  askingPriceUsd?: number;
  miles?: number;
};

export type AssembleDeps = {
  autodevKey?: string;
  servKey?: string;
  servModel?: string;
  servBaseUrl?: string;
  /** Which guard and explain profiles to use. Report, /check, and the agent API are separate profiles. */
  servSurface?: "report" | "check" | "agent";
  fetch?: typeof fetch;
  autodev?: Pick<AutodevDeps, "cache" | "counter">;
  now?: Date;
};

export type AssembleResult =
  | { ok: true; report: FullReport }
  | { ok: false; status: number; error: string; message: string };

function overlayStatedFacts(subject: Listing, input: AssembleInput): Listing {
  const next = { ...subject };
  if (typeof input.askingPriceUsd === "number" && input.askingPriceUsd > 0) next.priceUsd = input.askingPriceUsd;
  if (typeof input.miles === "number" && input.miles >= 0) next.miles = input.miles;
  return next;
}

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
  const model = deps.servModel || process.env.SERV_MODEL;
  const guardProfile: ProfileId = deps.servSurface === "check" ? "check_guard" : deps.servSurface === "agent" ? "agent_guard" : "report_guard";
  const explainProfile: ProfileId = deps.servSurface === "agent" ? "agent_explain" : "report_explain";

  let guardProof: ServProof | null = null;
  if (!deps.servKey) {
    steps.push({
      id: "serv_prompt_guard",
      status: "skipped",
      detail: "SERV_API_KEY is not set. The local screen still ran. The written summary is the template.",
    });
  } else {
    const guard = await runServ(guardProfile, { user: screened.text }, {
      fetch: fetchImpl,
      apiKey: deps.servKey,
      baseUrl: deps.servBaseUrl,
      model,
    });
    guardProof = guard.proof;
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

  const subject = overlayStatedFacts(resolved.subject, input);
  const computed = buildComputedReport({
    mode: input.mode,
    subject,
    candidates: resolved.candidates,
    recalls,
    complaintCount,
    fuel,
    vinDecode,
    distanceToSearchZipMiles: distance,
    asOfYear: (deps.now ?? new Date()).getUTCFullYear(),
    sample: resolved.sample,
  });
  if (typeof input.askingPriceUsd === "number") {
    computed.dataNotes.push("Asking price was typed in for this VIN. It did not come from a listing feed.");
  }
  if (typeof input.miles === "number") {
    computed.dataNotes.push("Mileage was typed in for this VIN. It did not come from a listing feed.");
  }
  steps.push({
    id: "deterministic_tools",
    status: "ran",
    detail:
      "selectComparables, mileageAdjust, historyAdjustment, verdictFromPriceGap, flipMath, scoreFromGap, dealerQuestions",
  });

  let explanation = templateExplanation(computed);
  let explanationSource: Proof["explanationSource"] = "template";
  let usedModel: string | null = null;
  const servChecks: ServProof[] = deps.servKey
    ? guardProof
      ? [guardProof]
      : []
    : [plannedProof(guardProfile), plannedProof("check_rules"), plannedProof(explainProfile)];
  const shadow = {
    requested: false,
    hint: SHADOW_HINT,
    maxIterations: SHADOW_MAX_ITERATIONS,
    outcome: deps.servKey ? "not_called" : "skipped_no_key",
  };

  if (deps.servKey) {
    shadow.requested = true;
    const facts = factsOf(computed);
    const allowed = JSON.stringify(facts);
    const rules = await runServ("check_rules", { user: JSON.stringify({ facts, userLookup: screened.text }) }, {
      fetch: fetchImpl,
      apiKey: deps.servKey,
      baseUrl: deps.servBaseUrl,
      model,
    });
    const rulesNote = rules.ok && quotedNumbersStayIn(rules.text, allowed) ? rules.text : null;
    if (!rulesNote) rules.proof.fallbackUsed = true;
    servChecks.push(rules.proof);
    const explained = await runServ(explainProfile, { user: JSON.stringify({ facts, userLookup: screened.text, rulesNote }), facts }, {
      fetch: fetchImpl,
      apiKey: deps.servKey,
      baseUrl: deps.servBaseUrl,
      model,
    });
    servChecks.push(explained.proof);
    if (!explained.ok) {
      shadow.outcome = "error";
      explanationSource = "unavailable";
      steps.push({ id: "serv_shadow_agent", status: "explanation_unavailable", detail: explained.error });
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
    servChecks,
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
  input: {
    make: string;
    model?: string;
    zip?: string;
    year?: number;
    yearMin?: number;
    yearMax?: number;
    distanceMiles?: number;
    mode: Mode;
  },
  deps: AssembleDeps,
): Promise<
  | { ok: true; listings: Listing[]; sample: boolean; message: string | null; proof: AgentProof }
  | { ok: false; status: number; error: string; message: string; proof: AgentProof }
> {
  const screened = screenUserInput(
    [input.make, input.model, input.zip, input.year?.toString(), input.yearMin?.toString(), input.yearMax?.toString()]
      .filter(Boolean)
      .join(" "),
  );
  const scanFields = ["score", "verdict", "reason", "priceUsd", "miles"];
  if (!screened.ok) {
    return { ok: false, status: 400, error: "rejected_input", message: screened.reason, proof: agentProof([plannedProof("radar_guard")], scanFields) };
  }
  const guard = await runServ("radar_guard", { user: screened.text }, {
    fetch: deps.fetch ?? fetch,
    apiKey: deps.servKey,
    baseUrl: deps.servBaseUrl,
    model: deps.servModel,
  });
  const proof = agentProof([guard.proof], scanFields);
  if (deps.servKey && (!guard.ok || interpretGuard(guard.text) === "block")) {
    return {
      ok: false,
      status: guard.ok ? 400 : 503,
      error: guard.ok ? "rejected_input" : "serv_unavailable",
      message: guard.ok
        ? "That input was rejected by the input check."
        : "The input check could not be completed, so this request was not run.",
      proof,
    };
  }
  if (!input.make.trim()) {
    return { ok: false, status: 400, error: "make_required", message: "Choose a make.", proof };
  }
  if (!deps.autodevKey || !deps.autodev) {
    return {
      ok: true,
      listings: sampleListings(),
      sample: true,
      message:
        "No listings key is configured. These five Toyota Camry rows are the labeled sample fixture. They are not the result of your search.",
      proof,
    };
  }
  const fetchImpl = deps.fetch ?? fetch;
  const years = yearQuery(input);
  const search = await autodevSearch(
    {
      make: input.make.trim(),
      model: input.model?.trim() || undefined,
      ...years,
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
      proof,
    };
  }
  return {
    ok: true,
    listings: search.listings,
    sample: false,
    message: search.listings.length === 0 ? "No listings came back for that search." : null,
    proof,
  };
}

function yearQuery(input: { year?: number; yearMin?: number; yearMax?: number }): { year?: number; yearRange?: string } {
  const min = input.yearMin ?? input.year;
  const max = input.yearMax ?? (input.yearMin ? undefined : input.year);
  if (min && max) {
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    return low === high ? { year: low } : { yearRange: `${low}-${high}` };
  }
  if (min) return { year: min };
  if (max) return { year: max };
  return {};
}
