/**
 * Owner-bound Find search context (t320/t314).
 *
 * Minted by /api/match after a real inventory search. Opaque token is the only
 * trust proof for /api/find/next-check — client-submitted need/listings are not
 * authoritative. Stores StructuredNeed + observed listing facts + applied checks
 * so rematch/replan always starts from server state.
 *
 * No invented TCO/history. No report-credit debit. TTL mirrors find analysis ctx.
 */
import type { FindFreeGovReceipt } from "@/domain/find-free-gov";
import type { ObservedListingRow } from "@/domain/find-model-observe";
import type { FindSearchRefine } from "@/domain/find-path";
import type { StructuredNeed } from "@/domain/need";
import type { Kv } from "@/io/kv";

export const FIND_SEARCH_CONTEXT_TTL_SEC = 60 * 60 * 2; // 2h

export type FindSearchListingFact = ObservedListingRow & {
  vin?: string | null;
  /** When present, best-deal market comps can share same-trim scope with card badges. */
  trim?: string | null;
};

export type FindSearchContextRecord = {
  v: 1;
  token: string;
  userId: string;
  need: StructuredNeed;
  refine: FindSearchRefine;
  listings: FindSearchListingFact[];
  appliedCheckIds: string[];
  /** Immutable free public NHTSA receipts (server-owned). */
  freeGovReceipts: FindFreeGovReceipt[];
  /** True when SERV_API_KEY was present at mint — UI may auto-start next-check. */
  servNextCheckEnabled: boolean;
  iat: number;
  exp: number;
};

function contextKey(userId: string, token: string): string {
  return `findsearch:v1:${userId}:${token}`;
}

export function mintFindSearchContextRecord(input: {
  userId: string;
  need: StructuredNeed;
  refine?: FindSearchRefine;
  listings: FindSearchListingFact[];
  servNextCheckEnabled: boolean;
  nowMs?: number;
  token?: string;
}): FindSearchContextRecord {
  const nowMs = input.nowMs ?? Date.now();
  const iat = Math.floor(nowMs / 1000);
  return {
    v: 1,
    token: input.token ?? crypto.randomUUID().replace(/-/g, ""),
    userId: input.userId,
    need: input.need,
    refine: input.refine ?? {},
    listings: input.listings.map((row) => ({
      make: row.make,
      model: row.model,
      year: row.year,
      priceUsd: row.priceUsd ?? null,
      miles: row.miles ?? null,
      vin: row.vin ?? null,
    })),
    appliedCheckIds: [],
    freeGovReceipts: [],
    servNextCheckEnabled: Boolean(input.servNextCheckEnabled),
    iat,
    exp: iat + FIND_SEARCH_CONTEXT_TTL_SEC,
  };
}

export async function storeFindSearchContext(kv: Kv, record: FindSearchContextRecord): Promise<void> {
  await kv.set(contextKey(record.userId, record.token), JSON.stringify(record));
}

export type FindSearchContextLoad =
  | { ok: true; record: FindSearchContextRecord }
  | {
      ok: false;
      reason: "missing_token" | "not_found" | "expired" | "wrong_user" | "malformed";
      message: string;
    };

export async function loadFindSearchContext(
  kv: Kv,
  input: { userId: string; token?: string | null; nowMs?: number },
): Promise<FindSearchContextLoad> {
  const token = (input.token ?? "").trim();
  if (!token) {
    return {
      ok: false,
      reason: "missing_token",
      message: "searchContextToken required — run Find again.",
    };
  }
  const raw = await kv.get(contextKey(input.userId, token));
  if (!raw) {
    return {
      ok: false,
      reason: "not_found",
      message: "Search context expired or unknown — run Find again.",
    };
  }
  let record: FindSearchContextRecord;
  try {
    record = JSON.parse(raw) as FindSearchContextRecord;
  } catch {
    return { ok: false, reason: "malformed", message: "Corrupt search context." };
  }
  if (record?.v !== 1 || typeof record.token !== "string" || !record.need) {
    return { ok: false, reason: "malformed", message: "Corrupt search context." };
  }
  if (!Array.isArray(record.freeGovReceipts)) {
    record.freeGovReceipts = [];
  }
  if (!Array.isArray(record.appliedCheckIds)) {
    record.appliedCheckIds = [];
  }
  if (record.userId !== input.userId) {
    return { ok: false, reason: "wrong_user", message: "Search context belongs to another session." };
  }
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (typeof record.exp === "number" && record.exp < nowSec) {
    return {
      ok: false,
      reason: "expired",
      message: "Search context expired — run Find again.",
    };
  }
  return { ok: true, record };
}

/** Persist need/listings/applied after next-check apply (+ optional rematch). */
export async function updateFindSearchContext(
  kv: Kv,
  record: FindSearchContextRecord,
  patch: {
    need?: StructuredNeed;
    refine?: FindSearchRefine;
    listings?: FindSearchListingFact[];
    appliedCheckIds?: string[];
    freeGovReceipts?: FindFreeGovReceipt[];
  },
): Promise<FindSearchContextRecord> {
  const next: FindSearchContextRecord = {
    ...record,
    need: patch.need ?? record.need,
    refine: patch.refine ?? record.refine,
    listings: patch.listings ?? record.listings,
    appliedCheckIds: patch.appliedCheckIds ?? record.appliedCheckIds,
    freeGovReceipts: patch.freeGovReceipts ?? record.freeGovReceipts ?? [],
  };
  await storeFindSearchContext(kv, next);
  return next;
}

/**
 * Same-REAL input export for Flip/parent comparison within TTL.
 * Sanitized: no credentials, no session secrets; listings already shopper-visible.
 */
export function exportFindSearchContextSanitized(record: FindSearchContextRecord): {
  schemaVersion: "find-search-context-export/v1";
  tokenFingerprint: string;
  need: StructuredNeed;
  refine: FindSearchRefine;
  listingCount: number;
  listings: FindSearchListingFact[];
  appliedCheckIds: string[];
  freeGovReceipts: FindFreeGovReceipt[];
  servNextCheckEnabled: boolean;
  iat: number;
  exp: number;
  honesty: string;
} {
  const tokenFingerprint = record.token.slice(0, 8);
  return {
    schemaVersion: "find-search-context-export/v1",
    tokenFingerprint,
    need: record.need,
    refine: record.refine,
    listingCount: record.listings.length,
    listings: record.listings,
    appliedCheckIds: record.appliedCheckIds,
    freeGovReceipts: record.freeGovReceipts ?? [],
    servNextCheckEnabled: record.servNextCheckEnabled,
    iat: record.iat,
    exp: record.exp,
    honesty:
      "Sanitized Find search context export — no API keys. Free-gov receipts are public NHTSA lookups; not NMVTIS/title clearance. Fixtures ≠ live proof.",
  };
}

export function listingsFromMatchDirections(
  directions: Array<{ listings?: Array<{
    make: string;
    model: string;
    year: number;
    priceUsd?: number | null;
    miles?: number | null;
    vin?: string;
    trim?: string | null;
    priceView?: { usableForBudget?: boolean } | null;
  }> }>,
): FindSearchListingFact[] {
  const out: FindSearchListingFact[] = [];
  for (const group of directions) {
    for (const row of group.listings ?? []) {
      const usable = row.priceView?.usableForBudget !== false;
      const trim =
        typeof row.trim === "string" && row.trim.trim() ? row.trim.trim() : row.trim === null ? null : undefined;
      out.push({
        make: row.make,
        model: row.model,
        year: row.year,
        priceUsd: usable && typeof row.priceUsd === "number" ? row.priceUsd : null,
        miles: typeof row.miles === "number" ? row.miles : null,
        vin: row.vin ?? null,
        ...(trim !== undefined ? { trim } : {}),
      });
    }
  }
  return out;
}
