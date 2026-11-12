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
import type { CarConsistencyReceipt } from "@/domain/find-car-consistency";
import type { FindDecisionLogEntry } from "@/domain/find-decision-log";
import type { FindFreeGovReceipt } from "@/domain/find-free-gov";
import type { ObservedListingRow } from "@/domain/find-model-observe";
import type { FindSearchRefine } from "@/domain/find-path";
import type { StructuredNeed } from "@/domain/need";
import type { Kv } from "@/io/kv";

export const FIND_SEARCH_CONTEXT_TTL_SEC = 60 * 60 * 2; // 2h

export type FindSearchListingFact = ObservedListingRow & {
  vin?: string | null;
  /** When present, the shared price path can adjust trim the same way the card badge does. */
  trim?: string | null;
  /** Listing-feed flags. The shared price path adjusts for them. */
  accidentCount?: number | null;
  cpo?: boolean | null;
  fuel?: string | null;
  engine?: string | null;
  drivetrain?: string | null;
  ownerCount?: number | null;
  oneOwner?: boolean | null;
  usageType?: string | null;
  createdAt?: string | null;
  city?: string | null;
  state?: string | null;
  dealer?: string | null;
  /** Auto.dev dealer page URL when the feed provided one (http/https only). */
  vdp?: string | null;
};

export type FindSearchContextRecord = {
  v: 1;
  token: string;
  userId: string;
  need: StructuredNeed;
  refine: FindSearchRefine;
  listings: FindSearchListingFact[];
  /**
   * Full provider-returned listings for market comps (may exceed shown `listings`).
   * When absent (older contexts), callers fall back to `listings`.
   */
  compsPool?: FindSearchListingFact[];
  appliedCheckIds: string[];
  /** Immutable free public NHTSA receipts (server-owned). */
  freeGovReceipts: FindFreeGovReceipt[];
  /** True when SERV_API_KEY was present at mint — UI may auto-start next-check. */
  servNextCheckEnabled: boolean;
  /** Paid SERV find_next_check HTTP calls so far this Find (accounting + hard cap). */
  servPaidCalls?: number;
  /** Shortlist fingerprint when SERV last ran — gates free-gov drain skips. */
  lastServShortlistFp?: string | null;
  /** Every next-check hop. Buyer UI formats this; it is not shown raw. */
  decisionLog?: FindDecisionLogEntry[];
  /** Per-car VIN/listing consistency receipts. */
  carChecks?: CarConsistencyReceipt[];
  /**
   * One paid SERV retarget is owed because the last SERV choice was a paid or
   * manual step while free public checks were still open.
   */
  servRetargetPending?: boolean;
  /**
   * True after a hop stopped with free public checks finished.
   * A later next-check returns that result and does not spend another paid call.
   */
  loopSettled?: boolean;
  /**
   * True after the one paid close-call tie-break for this Find.
   * Stops a second tie-break from spending another SERV call.
   */
  tieBreakSpent?: boolean;
  /** PR B: opaque shortlist keys from find_triage (bestDealCarKey). */
  triageShortlistKeys?: string[];
  /** PR B: inventory revisit already used once this Find. */
  triageRevisitUsed?: boolean;
  /** PR B: decide path active — UI calls /api/find/decide instead of next-check. */
  decidePathEnabled?: boolean;
  /** The Run permalink for this search. Decide finalizes this id, not a new one. */
  runId?: string | null;
  /**
   * Shopper form edits with provenance (origin user only). Carried into decide
   * so SERV sees the same bag as /api/need — never re-inferred from need defaults.
   */
  userFormEdits?: import("@/domain/search-spec").SearchFormEdits | null;
  /**
   * Mid-loop agentic SERV checkpoint (Responses input + journal + tool state).
   * When set, /api/find/decide resumes instead of restarting the loop.
   */
  agentLoopCheckpoint?: import("@/server/serv/agent-loop-checkpoint").AgentLoopCheckpoint | null;
  iat: number;
  exp: number;
};

function sanitizeListingFacts(rows: FindSearchListingFact[]): FindSearchListingFact[] {
  return rows.map((row) => {
    const trim =
      typeof row.trim === "string" && row.trim.trim()
        ? row.trim.trim()
        : row.trim === null
          ? null
          : undefined;
    const accidentCount =
      typeof row.accidentCount === "number" && Number.isFinite(row.accidentCount)
        ? Math.max(0, Math.floor(row.accidentCount))
        : row.accidentCount === null
          ? null
          : undefined;
    const cpo =
      row.cpo === true ? true : row.cpo === false ? false : row.cpo === null ? null : undefined;
    const text = (value: string | null | undefined) =>
      typeof value === "string" && value.trim() ? value.trim() : value === null ? null : undefined;
    const ownerCount =
      typeof row.ownerCount === "number" && Number.isFinite(row.ownerCount)
        ? Math.max(0, Math.floor(row.ownerCount))
        : row.ownerCount === null
          ? null
          : undefined;
    const oneOwner =
      row.oneOwner === true ? true : row.oneOwner === false ? false : row.oneOwner === null ? null : undefined;
    return {
      make: row.make,
      model: row.model,
      year: row.year,
      priceUsd: row.priceUsd ?? null,
      miles: row.miles ?? null,
      vin: row.vin ?? null,
      ...(trim !== undefined ? { trim } : {}),
      ...(accidentCount !== undefined ? { accidentCount } : {}),
      ...(cpo !== undefined ? { cpo } : {}),
      ...(text(row.fuel) !== undefined ? { fuel: text(row.fuel) } : {}),
      ...(text(row.engine) !== undefined ? { engine: text(row.engine) } : {}),
      ...(text(row.drivetrain) !== undefined ? { drivetrain: text(row.drivetrain) } : {}),
      ...(ownerCount !== undefined ? { ownerCount } : {}),
      ...(oneOwner !== undefined ? { oneOwner } : {}),
      ...(text(row.usageType) !== undefined ? { usageType: text(row.usageType) } : {}),
      ...(text(row.createdAt) !== undefined ? { createdAt: text(row.createdAt) } : {}),
      ...(text(row.city) !== undefined ? { city: text(row.city) } : {}),
      ...(text(row.state) !== undefined ? { state: text(row.state) } : {}),
      ...(text(row.dealer) !== undefined ? { dealer: text(row.dealer) } : {}),
      ...(httpVdpFact(row.vdp) !== undefined ? { vdp: httpVdpFact(row.vdp) } : {}),
    };
  });
}

/** Keep only absolute http(s) dealer URLs — fragments and bare hosts are not listing pages. */
function httpVdpFact(vdp: string | null | undefined): string | null | undefined {
  if (vdp === undefined) return undefined;
  if (vdp === null) return null;
  if (typeof vdp !== "string") return undefined;
  const trimmed = vdp.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || !url.hostname.includes(".")) return null;
    return trimmed;
  } catch {
    return null;
  }
}

function contextKey(userId: string, token: string): string {
  return `findsearch:v1:${userId}:${token}`;
}

export function mintFindSearchContextRecord(input: {
  userId: string;
  need: StructuredNeed;
  refine?: FindSearchRefine;
  listings: FindSearchListingFact[];
  /** Optional full provider pool for market comps (defaults to listings). */
  compsPool?: FindSearchListingFact[];
  servNextCheckEnabled: boolean;
  nowMs?: number;
  token?: string;
  /** User-origin form edits for decide / agent loop. */
  userFormEdits?: import("@/domain/search-spec").SearchFormEdits | null;
}): FindSearchContextRecord {
  const nowMs = input.nowMs ?? Date.now();
  const iat = Math.floor(nowMs / 1000);
  const listings = sanitizeListingFacts(input.listings);
  const compsPool = sanitizeListingFacts(input.compsPool ?? input.listings);
  return {
    v: 1,
    token: input.token ?? crypto.randomUUID().replace(/-/g, ""),
    userId: input.userId,
    need: input.need,
    refine: input.refine ?? {},
    listings,
    compsPool,
    appliedCheckIds: [],
    freeGovReceipts: [],
    servNextCheckEnabled: Boolean(input.servNextCheckEnabled),
    /** Paid SERV find_next_check HTTP calls this Find (bounded — see find-serv-budget). */
    servPaidCalls: 0,
    /** Shortlist fingerprint at last paid SERV call — skip SERV while free-gov drain is unchanged. */
    lastServShortlistFp: null,
    decisionLog: [],
    carChecks: [],
    servRetargetPending: false,
    loopSettled: false,
    tieBreakSpent: false,
    triageShortlistKeys: [],
    triageRevisitUsed: false,
    decidePathEnabled: false,
    userFormEdits: input.userFormEdits ?? null,
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
  if (!Array.isArray(record.decisionLog)) record.decisionLog = [];
  if (!Array.isArray(record.carChecks)) record.carChecks = [];
  if (!Array.isArray(record.triageShortlistKeys)) record.triageShortlistKeys = [];
  if (typeof record.triageRevisitUsed !== "boolean") record.triageRevisitUsed = false;
  if (typeof record.decidePathEnabled !== "boolean") record.decidePathEnabled = false;
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
    compsPool?: FindSearchListingFact[];
    appliedCheckIds?: string[];
    freeGovReceipts?: FindFreeGovReceipt[];
    servPaidCalls?: number;
    lastServShortlistFp?: string | null;
    decisionLog?: FindDecisionLogEntry[];
    carChecks?: CarConsistencyReceipt[];
    servRetargetPending?: boolean;
    loopSettled?: boolean;
    tieBreakSpent?: boolean;
    triageShortlistKeys?: string[];
    triageRevisitUsed?: boolean;
    decidePathEnabled?: boolean;
    runId?: string | null;
    userFormEdits?: import("@/domain/search-spec").SearchFormEdits | null;
    agentLoopCheckpoint?: import("@/server/serv/agent-loop-checkpoint").AgentLoopCheckpoint | null;
  },
): Promise<FindSearchContextRecord> {
  const next: FindSearchContextRecord = {
    ...record,
    need: patch.need ?? record.need,
    refine: patch.refine ?? record.refine,
    listings: patch.listings ?? record.listings,
    compsPool:
      patch.compsPool !== undefined
        ? sanitizeListingFacts(patch.compsPool)
        : (record.compsPool ?? record.listings),
    appliedCheckIds: patch.appliedCheckIds ?? record.appliedCheckIds,
    freeGovReceipts: patch.freeGovReceipts ?? record.freeGovReceipts ?? [],
    servPaidCalls: patch.servPaidCalls ?? record.servPaidCalls ?? 0,
    lastServShortlistFp:
      patch.lastServShortlistFp !== undefined
        ? patch.lastServShortlistFp
        : (record.lastServShortlistFp ?? null),
    decisionLog: patch.decisionLog ?? record.decisionLog ?? [],
    carChecks: patch.carChecks ?? record.carChecks ?? [],
    servRetargetPending:
      patch.servRetargetPending !== undefined
        ? patch.servRetargetPending
        : (record.servRetargetPending ?? false),
    loopSettled:
      patch.loopSettled !== undefined ? patch.loopSettled : (record.loopSettled ?? false),
    tieBreakSpent:
      patch.tieBreakSpent !== undefined ? patch.tieBreakSpent : (record.tieBreakSpent ?? false),
    triageShortlistKeys: patch.triageShortlistKeys ?? record.triageShortlistKeys ?? [],
    triageRevisitUsed:
      patch.triageRevisitUsed !== undefined
        ? patch.triageRevisitUsed
        : (record.triageRevisitUsed ?? false),
    decidePathEnabled:
      patch.decidePathEnabled !== undefined
        ? patch.decidePathEnabled
        : (record.decidePathEnabled ?? false),
    runId: patch.runId !== undefined ? patch.runId : (record.runId ?? null),
    userFormEdits:
      patch.userFormEdits !== undefined ? patch.userFormEdits : (record.userFormEdits ?? null),
    agentLoopCheckpoint:
      patch.agentLoopCheckpoint !== undefined
        ? patch.agentLoopCheckpoint
        : (record.agentLoopCheckpoint ?? null),
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
    accidentCount?: number | null;
    cpo?: boolean | null;
    fuel?: string | null;
    engine?: string | null;
    drivetrain?: string | null;
    ownerCount?: number | null;
    oneOwner?: boolean | null;
    usageType?: string | null;
    createdAt?: string | null;
    city?: string | null;
    state?: string | null;
    dealer?: string | null;
    vdp?: string | null;
    priceView?: { usableForBudget?: boolean } | null;
  }> }>,
): FindSearchListingFact[] {
  const out: FindSearchListingFact[] = [];
  for (const group of directions) {
    for (const row of group.listings ?? []) {
      const usable = row.priceView?.usableForBudget !== false;
      const trim =
        typeof row.trim === "string" && row.trim.trim() ? row.trim.trim() : row.trim === null ? null : undefined;
      const vdp = httpVdpFact(row.vdp);
      out.push({
        make: row.make,
        model: row.model,
        year: row.year,
        priceUsd: usable && typeof row.priceUsd === "number" ? row.priceUsd : null,
        miles: typeof row.miles === "number" ? row.miles : null,
        vin: row.vin ?? null,
        ...(trim !== undefined ? { trim } : {}),
        ...(row.accidentCount !== undefined ? { accidentCount: row.accidentCount } : {}),
        ...(row.cpo !== undefined ? { cpo: row.cpo } : {}),
        ...(row.fuel !== undefined ? { fuel: row.fuel } : {}),
        ...(row.engine !== undefined ? { engine: row.engine } : {}),
        ...(row.drivetrain !== undefined ? { drivetrain: row.drivetrain } : {}),
        ...(row.ownerCount !== undefined ? { ownerCount: row.ownerCount } : {}),
        ...(row.oneOwner !== undefined ? { oneOwner: row.oneOwner } : {}),
        ...(row.usageType !== undefined ? { usageType: row.usageType } : {}),
        ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
        ...(row.city !== undefined ? { city: row.city } : {}),
        ...(row.state !== undefined ? { state: row.state } : {}),
        ...(row.dealer !== undefined ? { dealer: row.dealer } : {}),
        ...(vdp !== undefined ? { vdp } : {}),
      });
    }
  }
  return out;
}

/** Map a match compsPool (full provider returns) into search-context listing facts. */
export function listingFactsFromCompsPool(
  pool: Array<{
    make: string;
    model: string;
    year: number;
    priceUsd?: number | null;
    miles?: number | null;
    vin?: string | null;
    trim?: string | null;
    accidentCount?: number | null;
    cpo?: boolean | null;
    fuel?: string | null;
    engine?: string | null;
    drivetrain?: string | null;
    ownerCount?: number | null;
    oneOwner?: boolean | null;
    usageType?: string | null;
    createdAt?: string | null;
    city?: string | null;
    state?: string | null;
    dealer?: string | null;
    vdp?: string | null;
  }>,
): FindSearchListingFact[] {
  return sanitizeListingFacts(
    pool.map((row) => ({
      make: row.make,
      model: row.model,
      year: row.year,
      priceUsd: typeof row.priceUsd === "number" ? row.priceUsd : null,
      miles: typeof row.miles === "number" ? row.miles : null,
      vin: row.vin ?? null,
      trim: typeof row.trim === "string" && row.trim.trim() ? row.trim.trim() : row.trim ?? null,
      ...(row.accidentCount !== undefined ? { accidentCount: row.accidentCount } : {}),
      ...(row.cpo !== undefined ? { cpo: row.cpo } : {}),
      ...(row.fuel !== undefined ? { fuel: row.fuel } : {}),
      ...(row.vdp !== undefined ? { vdp: row.vdp } : {}),
      ...(row.engine !== undefined ? { engine: row.engine } : {}),
      ...(row.drivetrain !== undefined ? { drivetrain: row.drivetrain } : {}),
      ...(row.ownerCount !== undefined ? { ownerCount: row.ownerCount } : {}),
      ...(row.oneOwner !== undefined ? { oneOwner: row.oneOwner } : {}),
      ...(row.usageType !== undefined ? { usageType: row.usageType } : {}),
      ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
      ...(row.city !== undefined ? { city: row.city } : {}),
      ...(row.state !== undefined ? { state: row.state } : {}),
      ...(row.dealer !== undefined ? { dealer: row.dealer } : {}),
    })),
  );
}

/** Build Listing stubs for the shared price path / selectBestDealOnEvidence.marketPool. */
export function marketPoolFromListingFacts(
  rows: readonly FindSearchListingFact[],
): import("@/domain/types").Listing[] {
  const out: import("@/domain/types").Listing[] = [];
  const seenVins = new Set<string>();
  for (const row of rows) {
    if (row.priceUsd == null || row.miles == null) continue;
    const vin =
      typeof row.vin === "string" && row.vin.trim() && !row.vin.startsWith("UNKNOWN-")
        ? row.vin.trim().toUpperCase()
        : `FIND-${row.year}-${row.make}-${row.model}-${row.priceUsd}-${row.miles}`;
    if (seenVins.has(vin)) continue;
    seenVins.add(vin);
    const trim =
      typeof row.trim === "string" && row.trim.trim()
        ? row.trim.trim()
        : row.trim === null
          ? null
          : null;
    out.push({
      vin,
      year: row.year,
      make: row.make,
      model: row.model,
      trim,
      priceUsd: row.priceUsd,
      miles: row.miles,
      city: row.city ?? null,
      state: row.state ?? null,
      zip: null,
      dealer: row.dealer ?? null,
      vdp: httpVdpFact(row.vdp) ?? null,
      primaryImage: null,
      carfaxUrl: null,
      used: true,
      // Feed flags change the adjusted fair value. Keep them on the pool the badge uses.
      cpo: row.cpo ?? null,
      accidentCount: row.accidentCount ?? null,
      oneOwner: row.oneOwner ?? null,
      ownerCount: row.ownerCount ?? null,
      usageType: row.usageType ?? null,
      fuel: row.fuel ?? null,
      engine: row.engine ?? null,
      drivetrain: row.drivetrain ?? null,
      bodyStyle: null,
      latitude: null,
      longitude: null,
      removedAt: null,
      createdAt: row.createdAt ?? null,
      source: "autodev",
    });
  }
  return out;
}
