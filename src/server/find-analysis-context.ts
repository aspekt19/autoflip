/**
 * Server-origin discovered-listing context for /find → full analysis.
 *
 * Trust is NOT client `surface`/`cta`/heuristics. The match route mints an opaque
 * token and stores owner-bound facts in Kv (same store as credits/comps). Report
 * verifies the token + owner + VIN + exact VDP + freshness BEFORE balance /
 * assemble / spend. No HTTP fetch of arbitrary client VDPs.
 */
import { askingPriceSafeToState } from "@/domain/find-listing-price";
import type { Kv } from "@/io/kv";

export const FIND_ANALYSIS_CONTEXT_TTL_SEC = 60 * 60 * 2; // 2h — covers credit checkout resume

export type FindAnalysisContextRecord = {
  v: 1;
  token: string;
  userId: string;
  vin: string;
  vdp: string | null;
  miles: number | null;
  zip: string | null;
  /** Only set when the feed figure was usable as a purchase ask at mint time. */
  askingPriceUsd: number | null;
  year: number;
  make: string;
  model: string;
  iat: number;
  exp: number;
};

export type FindListingForContext = {
  vin: string;
  year: number;
  make: string;
  model: string;
  miles: number | null;
  priceUsd: number | null;
  vdp: string | null;
  zip?: string | null;
  /** When present, prefer usableForBudget over raw priceUsd. */
  priceView?: { usableForBudget?: boolean } | null;
};

function contextKey(userId: string, token: string): string {
  return `findctx:v1:${userId}:${token}`;
}

function vinIndexKey(userId: string, vin: string): string {
  return `findctx:vin:${userId}:${vin.toUpperCase()}`;
}

function httpVdp(vdp: string | null | undefined): string | null {
  if (!vdp) return null;
  const trimmed = vdp.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function normalizeZip(zip: string | null | undefined): string | null {
  const t = (zip ?? "").trim();
  return /^\d{5}$/.test(t) ? t : null;
}

export function mintFindAnalysisContextRecord(
  userId: string,
  listing: FindListingForContext,
  needZip: string | null | undefined,
  nowMs = Date.now(),
  token = crypto.randomUUID().replace(/-/g, ""),
): FindAnalysisContextRecord {
  const vin = listing.vin.trim().toUpperCase();
  const usableAsk =
    listing.priceView?.usableForBudget === true ||
    (listing.priceView == null && askingPriceSafeToState(listing.priceUsd, listing.year));
  const iat = Math.floor(nowMs / 1000);
  return {
    v: 1,
    token,
    userId,
    vin,
    vdp: httpVdp(listing.vdp),
    miles:
      typeof listing.miles === "number" && Number.isFinite(listing.miles) && listing.miles >= 0
        ? listing.miles
        : null,
    // Bind the find-session search ZIP when present. Autodev retail.zip is the
    // dealer location and often differs from the shopper's search ZIP; the card
    // CTA claims need.zip (see resolveSelectedListingHandoff). Preferring dealer
    // ZIP here falsely tripped tampered_facts on legit Full analysis (t309).
    zip: normalizeZip(needZip) ?? normalizeZip(listing.zip),
    askingPriceUsd:
      usableAsk && typeof listing.priceUsd === "number" && listing.priceUsd > 0
        ? listing.priceUsd
        : null,
    year: listing.year,
    make: listing.make,
    model: listing.model,
    iat,
    exp: iat + FIND_ANALYSIS_CONTEXT_TTL_SEC,
  };
}

export async function storeFindAnalysisContext(
  kv: Kv,
  record: FindAnalysisContextRecord,
): Promise<void> {
  await kv.set(contextKey(record.userId, record.token), JSON.stringify(record));
  await kv.set(vinIndexKey(record.userId, record.vin), record.token);
}

/**
 * Mint + store contexts for every visible find card. Returns vin → token.
 * Idempotent per user+vin (latest mint wins).
 */
export async function rememberFindAnalysisContexts(
  kv: Kv,
  userId: string,
  listings: FindListingForContext[],
  needZip: string | null | undefined,
  nowMs = Date.now(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const listing of listings) {
    const vin = (listing.vin || "").trim().toUpperCase();
    if (!vin) continue;
    const record = mintFindAnalysisContextRecord(userId, { ...listing, vin }, needZip, nowMs);
    await storeFindAnalysisContext(kv, record);
    out.set(vin, record.token);
  }
  return out;
}

export type FindContextVerification =
  | { ok: true; record: FindAnalysisContextRecord }
  | {
      ok: false;
      error: "find_context_invalid";
      reason:
        | "missing_token"
        | "not_found"
        | "expired"
        | "wrong_user"
        | "vin_mismatch"
        | "vdp_mismatch"
        | "tampered_facts"
        | "malformed";
      message: string;
    };

const INVALID_MSG =
  "That find result is no longer trusted for full analysis. Run Find again and choose the same car, or paste a listing URL on Check a car. No credit was charged.";

/**
 * Verify server-minted find context BEFORE balance / assemble / spend.
 * Client surface/cta are ignored as proof — only the opaque token + stored facts count.
 */
export async function verifyFindAnalysisContext(
  kv: Kv,
  input: {
    userId: string;
    token?: string | null;
    vin: string;
    /** Client-claimed VDP (url or selectedVdp). Must match stored exact VDP when either side has one. */
    claimedVdp?: string | null;
    claimedMiles?: number | null;
    claimedZip?: string | null;
  },
  nowMs = Date.now(),
): Promise<FindContextVerification> {
  const token = (input.token || "").trim();
  if (!token) {
    return { ok: false, error: "find_context_invalid", reason: "missing_token", message: INVALID_MSG };
  }

  const raw = await kv.get(contextKey(input.userId, token));
  if (!raw) {
    return { ok: false, error: "find_context_invalid", reason: "not_found", message: INVALID_MSG };
  }

  let record: FindAnalysisContextRecord;
  try {
    record = JSON.parse(raw) as FindAnalysisContextRecord;
  } catch {
    return { ok: false, error: "find_context_invalid", reason: "malformed", message: INVALID_MSG };
  }

  if (record.v !== 1 || !record.token || !record.userId || !record.vin) {
    return { ok: false, error: "find_context_invalid", reason: "malformed", message: INVALID_MSG };
  }
  if (record.userId !== input.userId) {
    return { ok: false, error: "find_context_invalid", reason: "wrong_user", message: INVALID_MSG };
  }
  if (record.exp * 1000 <= nowMs) {
    return { ok: false, error: "find_context_invalid", reason: "expired", message: INVALID_MSG };
  }

  const vin = input.vin.trim().toUpperCase();
  if (record.vin !== vin) {
    return { ok: false, error: "find_context_invalid", reason: "vin_mismatch", message: INVALID_MSG };
  }

  const claimedVdp = httpVdp(input.claimedVdp);
  const storedVdp = httpVdp(record.vdp);
  // Exact VDP binding: client must not substitute an arbitrary listing URL.
  if (storedVdp && claimedVdp && storedVdp !== claimedVdp) {
    return { ok: false, error: "find_context_invalid", reason: "vdp_mismatch", message: INVALID_MSG };
  }
  if (storedVdp && !claimedVdp) {
    // Client omitted VDP but server discovered one — still OK; server facts win.
  }
  if (!storedVdp && claimedVdp) {
    // Client invented a VDP the server never stored.
    return { ok: false, error: "find_context_invalid", reason: "vdp_mismatch", message: INVALID_MSG };
  }

  // Optional claimed miles/zip must match stored facts when the client sends them.
  if (
    typeof input.claimedMiles === "number" &&
    record.miles != null &&
    input.claimedMiles !== record.miles
  ) {
    return { ok: false, error: "find_context_invalid", reason: "tampered_facts", message: INVALID_MSG };
  }
  const claimedZip = normalizeZip(input.claimedZip ?? null);
  if (claimedZip && record.zip && claimedZip !== record.zip) {
    return { ok: false, error: "find_context_invalid", reason: "tampered_facts", message: INVALID_MSG };
  }

  return { ok: true, record };
}

/** True when the request is claiming a /find selected-listing handoff (not manual check). */
export function claimsFindAnalysisHandoff(input: {
  surface?: string | null;
  cta?: string | null;
  findContextToken?: string | null;
}): boolean {
  if (input.findContextToken && String(input.findContextToken).trim()) return true;
  if (input.surface === "find") return true;
  return input.cta === "find_card_full_analysis" || input.cta === "find_pending_retry";
}
