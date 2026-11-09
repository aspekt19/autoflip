/**
 * Server orchestration for minimal /resale evaluate.
 * Uses Autodev comps + shared evaluateListingPrice + buildResaleAssessment.
 */
import { GENERATION_YEAR_WINDOW } from "@/domain/adjusted-comparables";
import { autoDevMake, autoDevModel } from "@/domain/vehicle-names";
import { evaluateListingPrice } from "@/domain/price-evaluation";
import { buildResaleAssessment, type ResaleAssessment } from "@/domain/resale-evaluate";
import type { RepairAbility } from "@/domain/need";
import type { Listing } from "@/domain/types";
import { autodevSearch, type AutodevDeps } from "@/io/autodev";
import type { ListingQuery } from "@/io/marketcheck";
import { getKv, type Kv } from "@/io/kv";
import { isServerlessRuntime, requireSharedQuotaForPaidDispatch } from "@/server/paid-dispatch-guard";
import { screenUserInput } from "@/domain/screen";

export type ResaleEvaluateInput = {
  year: number;
  make: string;
  model: string;
  miles: number;
  askingUsd: number;
  trim?: string | null;
  zip?: string | null;
  accidentCount?: number | null;
  repairAbility?: RepairAbility;
  targetProfitUsd?: number | null;
};

export type ResaleEvaluateDeps = {
  autodevKey?: string;
  autodev?: Pick<AutodevDeps, "cache" | "counter" | "reserve" | "signal" | "timeoutMs">;
  fetch?: typeof fetch;
  kv?: Kv;
  env?: Record<string, string | undefined>;
  now?: Date;
};

export type ResaleEvaluateResult =
  | { ok: true; assessment: ResaleAssessment; title: string; sample: boolean }
  | { ok: false; status: number; error: string; message: string };

/** Same make/model window the shared price math will accept. One model year would hide comps and look like a thin market. */
export function resaleListingQuery(input: ResaleEvaluateInput, now = new Date()): ListingQuery {
  const yearMin = Math.max(1981, input.year - GENERATION_YEAR_WINDOW);
  const yearMax = Math.min(now.getUTCFullYear() + 1, input.year + GENERATION_YEAR_WINDOW);
  const zip = input.zip?.replace(/\D/g, "").slice(0, 5) || undefined;
  return {
    make: autoDevMake(input.make),
    model: autoDevModel(input.model),
    yearRange: `${yearMin}-${yearMax}`,
    zip,
    distanceMiles: zip ? 500 : undefined,
    limit: 24,
    used: true,
  };
}

export async function evaluateResaleDeal(
  input: ResaleEvaluateInput,
  deps: ResaleEvaluateDeps = {},
): Promise<ResaleEvaluateResult> {
  const make = autoDevMake(input.make);
  const model = autoDevModel(input.model);
  const screened = screenUserInput(`${input.year} ${make} ${model}`);
  if (!screened.ok) {
    return { ok: false, status: 400, error: "rejected_input", message: screened.reason };
  }
  if (!Number.isFinite(input.year) || input.year < 1981 || input.year > new Date().getUTCFullYear() + 1) {
    return { ok: false, status: 400, error: "invalid_year", message: "Enter a valid model year." };
  }
  if (!make || !model) {
    return { ok: false, status: 400, error: "missing_vehicle", message: "Enter a make and model." };
  }
  if (!Number.isFinite(input.miles) || input.miles < 0) {
    return { ok: false, status: 400, error: "invalid_miles", message: "Enter mileage as a non-negative number." };
  }
  if (!Number.isFinite(input.askingUsd) || input.askingUsd <= 0) {
    return { ok: false, status: 400, error: "invalid_ask", message: "Enter the asking price you would pay." };
  }

  if (!deps.autodevKey || !deps.autodev) {
    return {
      ok: false,
      status: 503,
      error: "listings_unconfigured",
      message: "Live dealer listings are not configured in this environment, so a resale estimate cannot run.",
    };
  }

  const kv = deps.kv ?? getKv();
  const gate = requireSharedQuotaForPaidDispatch({
    kv,
    serverless: isServerlessRuntime(deps.env ?? process.env),
  });
  if (!gate.ok) {
    return { ok: false, status: 503, error: "quota_backend_not_distributed", message: gate.message };
  }

  const query = resaleListingQuery(input, deps.now);
  const zip = query.zip;
  const search = await autodevSearch(
    query,
    {
      fetch: deps.fetch ?? fetch,
      cache: deps.autodev.cache,
      counter: deps.autodev.counter,
      apiKey: deps.autodevKey,
      now: deps.now,
      reserve: deps.autodev.reserve,
      signal: deps.autodev.signal,
      timeoutMs: deps.autodev.timeoutMs,
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

  const subject: Listing = {
    vin: "RESALE-SUBJECT",
    year: input.year,
    make,
    model,
    trim: input.trim?.trim() || null,
    miles: input.miles,
    priceUsd: input.askingUsd,
    city: null,
    state: null,
    zip: zip ?? null,
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: input.accidentCount ?? null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    askingPriceKind: "purchase_ask",
  };

  const pool = [subject, ...search.listings.filter((row) => row.vin !== subject.vin)];
  const evaluation = evaluateListingPrice(subject, pool, { mode: "flip" });
  const assessment = buildResaleAssessment({
    askingUsd: input.askingUsd,
    miles: input.miles,
    accidentCount: input.accidentCount ?? null,
    evaluation,
    repairAbility: input.repairAbility,
    targetProfitUsd: input.targetProfitUsd,
  });

  return {
    ok: true,
    assessment,
    title: `${input.year} ${make} ${model}`,
    sample: false,
  };
}
