/**
 * Selected-listing → full-analysis handoff for /find.
 *
 * The service already discovered the listing. Do not ask the shopper to paste a
 * URL we hold. Prefer VIN identity from the card; keep VDP URL as provenance.
 * Fail closed before credit spend when the target is not analyzable.
 */
import { askingPriceSafeToState } from "@/domain/find-listing-price";
import type { RepairAbility } from "@/domain/need";
import type { Mode } from "@/domain/types";
import { isValidVin, extractVin } from "@/domain/vin";
import { isListingUrl } from "@/domain/vin-report";

export type FindAnalysisCta =
  | "find_card_full_analysis"
  | "find_pending_retry"
  | "check_manual_url"
  | "check_manual_vin";

export type SelectedListingCard = {
  vin: string;
  year: number;
  make: string;
  model: string;
  trim?: string | null;
  miles: number | null;
  priceUsd: number | null;
  vdp: string | null;
  zip?: string | null;
  source?: string;
  /** Opaque token minted by /api/match — required for trusted full analysis. */
  analysisContextToken?: string | null;
};

export type FindAnalysisNeedContext = {
  mode: Mode;
  zip: string | null;
  repairAbility?: RepairAbility;
  targetProfitUsd?: number | null;
};

export type FindAnalysisPayload = {
  mode: Mode;
  surface: "find" | "check";
  cta: FindAnalysisCta;
  vin?: string;
  url?: string;
  zip?: string;
  miles?: number;
  askingPriceUsd?: number;
  year?: number;
  make?: string;
  model?: string;
  repairAbility?: RepairAbility;
  targetProfitUsd?: number;
  /** Non-secret listing id retained for idempotent retry / UI restore. */
  selectedVin: string;
  selectedVdp: string | null;
  /**
   * Opaque server-minted token from /api/match. Required for trusted /find handoff.
   * Not a credential — bound server-side to owner + VIN + VDP + facts + expiry.
   */
  findContextToken?: string;
};

export type FindAnalysisHandoffResult =
  | { ok: true; payload: FindAnalysisPayload }
  | {
      ok: false;
      error: "missing_identity" | "invalid_vin" | "unsupported_source" | "missing_url";
      message: string;
    };

function httpVdp(vdp: string | null | undefined): string | null {
  if (!vdp) return null;
  const trimmed = vdp.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/**
 * Build the /api/report body for a card the shopper selected on free /find results.
 * Always carries VIN when the card has one — dealer VDPs often omit the VIN in the URL.
 */
export function resolveSelectedListingHandoff(
  car: SelectedListingCard,
  need: FindAnalysisNeedContext,
  cta: FindAnalysisCta = "find_card_full_analysis",
): FindAnalysisHandoffResult {
  const vin = (car.vin || "").trim().toUpperCase();
  const vdp = httpVdp(car.vdp);

  if (car.source && car.source !== "autodev" && car.source !== "sample") {
    return {
      ok: false,
      error: "unsupported_source",
      message: "That listing source is not supported for full analysis.",
    };
  }

  if (!vin || !isValidVin(vin)) {
    // Last resort: VIN embedded in the dealer URL.
    const fromUrl = vdp ? extractVin(vdp) : null;
    if (!fromUrl) {
      return {
        ok: false,
        error: "missing_identity",
        message:
          "This result is missing a usable VIN, so full analysis cannot start. Pick another card, or paste a listing link that includes the VIN on Check a car.",
      };
    }
    return buildPayload({
      vin: fromUrl,
      vdp,
      car: { ...car, vin: fromUrl },
      need,
      cta,
    });
  }

  return buildPayload({ vin, vdp, car, need, cta });
}

function buildPayload(input: {
  vin: string;
  vdp: string | null;
  car: SelectedListingCard;
  need: FindAnalysisNeedContext;
  cta: FindAnalysisCta;
}): FindAnalysisHandoffResult {
  const { vin, vdp, car, need, cta } = input;
  const zip = (need.zip || car.zip || "").trim() || undefined;
  const miles = typeof car.miles === "number" && Number.isFinite(car.miles) ? car.miles : undefined;
  // Never promote a fee/placeholder feed figure as a shopper-stated asking price.
  const askingPriceUsd = askingPriceSafeToState(car.priceUsd, car.year) ? car.priceUsd! : undefined;

  const token = (car.analysisContextToken || "").trim();
  if (!token) {
    return {
      ok: false,
      error: "missing_identity",
      message:
        "This find result is missing a server analysis token. Run Find again and choose the same car — do not paste a forged listing URL.",
    };
  }

  const payload: FindAnalysisPayload = {
    mode: need.mode,
    surface: "find",
    cta,
    vin,
    selectedVin: vin,
    selectedVdp: vdp,
    findContextToken: token,
    year: car.year,
    make: car.make,
    model: car.model,
  };
  if (vdp) payload.url = vdp;
  if (zip) payload.zip = zip;
  if (miles !== undefined) payload.miles = miles;
  if (askingPriceUsd !== undefined) payload.askingPriceUsd = askingPriceUsd;
  if (need.repairAbility && need.repairAbility !== "unknown") payload.repairAbility = need.repairAbility;
  if (typeof need.targetProfitUsd === "number") payload.targetProfitUsd = need.targetProfitUsd;
  return { ok: true, payload };
}

/** Manual Check-a-car URL path — still requires an analyzable URL or VIN before charge. */
export function resolveManualCheckHandoff(input: {
  mode: Mode;
  kind: "link" | "vin";
  lookup: string;
  askingPriceUsd?: number | null;
  miles?: number | null;
  zip?: string | null;
}): FindAnalysisHandoffResult {
  const lookup = input.lookup.trim();
  if (!lookup) {
    return {
      ok: false,
      error: input.kind === "link" ? "missing_url" : "missing_identity",
      message: input.kind === "link" ? "Paste a listing link." : "Enter a 17-character VIN.",
    };
  }
  if (input.kind === "link") {
    if (!isListingUrl(lookup)) {
      return {
        ok: false,
        error: "missing_url",
        message: "Paste a listing link that starts with http:// or https://.",
      };
    }
    const vin = extractVin(lookup);
    if (!vin) {
      return {
        ok: false,
        error: "missing_identity",
        message: "That link does not include a VIN. Paste a dealer link that contains the VIN, or enter the VIN directly.",
      };
    }
    return {
      ok: true,
      payload: {
        mode: input.mode,
        surface: "check",
        cta: "check_manual_url",
        url: lookup,
        vin,
        selectedVin: vin,
        selectedVdp: lookup,
        zip: input.zip?.trim() || undefined,
      },
    };
  }

  const vin = lookup.toUpperCase();
  if (!isValidVin(vin)) {
    return {
      ok: false,
      error: "invalid_vin",
      message: "Enter a valid 17-character VIN.",
    };
  }
  const zip = input.zip?.trim() || undefined;
  const miles = typeof input.miles === "number" ? input.miles : undefined;
  const askingPriceUsd =
    typeof input.askingPriceUsd === "number" && input.askingPriceUsd > 0 ? input.askingPriceUsd : undefined;
  return {
    ok: true,
    payload: {
      mode: input.mode,
      surface: "check",
      cta: "check_manual_vin",
      vin,
      selectedVin: vin,
      selectedVdp: null,
      zip,
      miles,
      askingPriceUsd,
    },
  };
}

/**
 * Pre-charge identity gate shared by /api/report.
 * Returns a message when the request cannot be analyzed — caller must not charge.
 */
export function prechargeAnalysisGate(input: { url?: string; vin?: string }): {
  ok: true;
  vin: string;
} | {
  ok: false;
  error: "vin_required";
  message: string;
} {
  const vin = extractVin(input.vin || input.url || "");
  if (!vin) {
    return {
      ok: false,
      error: "vin_required",
      message:
        "A full report needs one vehicle. Choose a car from your find results, or paste a listing URL that contains a VIN.",
    };
  }
  return { ok: true, vin };
}

/**
 * @deprecated Client/heuristic trust is not a server trust boundary.
 * Use `verifyFindAnalysisContext` (Kv-backed opaque token) on the report route.
 * Kept only so unit tests document why surface/cta/VDP heuristics are insufficient.
 */
export function isTrustedFindAnalysisContext(_input: {
  surface?: string | null;
  cta?: string | null;
  vin: string;
  url?: string | null;
  selectedVin?: string | null;
  selectedVdp?: string | null;
  miles?: number | null;
  zip?: string | null;
  findContextToken?: string | null;
}): boolean {
  // Heuristics alone never grant trust — even with matching VIN/VDP/CTA/miles/ZIP.
  return false;
}
