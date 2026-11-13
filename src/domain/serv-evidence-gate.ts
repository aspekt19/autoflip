/**
 * Attempt-only evidence gate for Find/Resale submit_picks.
 *
 * SERV must attempt each required source for each picked VIN (one call per source).
 * Any outcome (data, empty, error, unavailable) counts as covered.
 * Missing attempt → one repair. After that repair, accept and mark "not checked".
 * Never fail the run because a source returned empty/error/timeout.
 * Disabled/unavailable tools are omitted from requiredSources.
 */

export type EvidenceSourceId =
  | "recalls_complaints"
  | "safety_ratings"
  | "vin_decode"
  | "fuel_economy"
  | "market_comps"
  | "flip_pnl";

export type EvidenceStatus =
  | "checked"
  | "empty"
  | "error"
  | "unavailable"
  | "not_checked";

export type EvidenceSourceRow = {
  source: EvidenceSourceId;
  status: EvidenceStatus;
  label: string;
};

export type EvidenceListingFact = {
  vin: string;
  year: number;
  make: string;
  model: string;
};

export type EvidenceJournalToolRow = {
  name: string;
  args: unknown;
  ok: boolean;
  summary?: string;
  result?: unknown;
};

export const FIND_EVIDENCE_SOURCES: readonly EvidenceSourceId[] = [
  "recalls_complaints",
  "safety_ratings",
  "vin_decode",
  "fuel_economy",
  "market_comps",
] as const;

export const RESALE_EVIDENCE_SOURCES: readonly EvidenceSourceId[] = [
  ...FIND_EVIDENCE_SOURCES,
  "flip_pnl",
] as const;

export const EVIDENCE_SOURCE_LABELS: Record<EvidenceSourceId, string> = {
  recalls_complaints: "Recalls & complaints",
  safety_ratings: "Safety ratings",
  vin_decode: "VIN decode",
  fuel_economy: "Fuel economy",
  market_comps: "Market comps",
  flip_pnl: "Flip P&L",
};

function normKeyPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function mmyKey(year: number, make: string, model: string): string {
  return `${Math.round(year)}|${normKeyPart(make)}|${normKeyPart(model)}`;
}

export function makeModelKey(make: string, model: string): string {
  return `${normKeyPart(make)}|${normKeyPart(model)}`;
}

function vinsFromArgs(args: unknown): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const row = args as Record<string, unknown>;
  const out: string[] = [];
  if (typeof row.vin === "string") {
    const vin = row.vin.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (vin.length >= 11) out.push(vin);
  }
  if (Array.isArray(row.vins)) {
    for (const item of row.vins) {
      if (typeof item !== "string") continue;
      const vin = item.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (vin.length >= 11) out.push(vin);
    }
  }
  return out;
}

function mmyFromArgs(args: unknown): { year: number; make: string; model: string } | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const row = args as Record<string, unknown>;
  const make = typeof row.make === "string" ? row.make.trim() : "";
  const model = typeof row.model === "string" ? row.model.trim() : "";
  const yearRaw = typeof row.year === "number" ? row.year : Number(row.year);
  if (!make || !model || !Number.isFinite(yearRaw)) return null;
  return { year: Math.round(yearRaw), make, model };
}

function makeModelFromArgs(args: unknown): { make: string; model: string } | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const row = args as Record<string, unknown>;
  const make = typeof row.make === "string" ? row.make.trim() : "";
  const model = typeof row.model === "string" ? row.model.trim() : "";
  if (!make || !model) return null;
  return { make, model };
}

function statusFromToolRow(row: EvidenceJournalToolRow): Exclude<EvidenceStatus, "not_checked"> {
  const result =
    row.result && typeof row.result === "object" && !Array.isArray(row.result)
      ? (row.result as Record<string, unknown>)
      : null;
  if (result) {
    if (result.error != null || result.unavailable === true) return "error";
    if (result.empty === true) return "empty";
    if (result.available === false) return "unavailable";
    // Explicit empty menus / zero rows still count as an attempt with empty data.
    if (
      (Array.isArray(result.cards) && result.cards.length === 0) ||
      (Array.isArray(result.vehicles) && result.vehicles.length === 0) ||
      (Array.isArray(result.decodes) && result.decodes.length === 0) ||
      result.recallCount === 0 ||
      result.complaintCount === 0
    ) {
      // Only treat as empty when the call itself succeeded.
      if (row.ok) return "empty";
    }
  }
  if (!row.ok) {
    if (/unavailable|disabled|not configured/i.test(row.summary ?? "")) return "unavailable";
    return "error";
  }
  return "checked";
}

export type EvidenceAttemptIndex = {
  /** source → set of coverage keys (VIN upper, or mmyKey, or makeModelKey). */
  bySource: Map<EvidenceSourceId, Map<string, EvidenceStatus>>;
};

export function buildEvidenceAttemptIndex(
  journal: readonly EvidenceJournalToolRow[],
): EvidenceAttemptIndex {
  const bySource = new Map<EvidenceSourceId, Map<string, EvidenceStatus>>();
  const touch = (source: EvidenceSourceId, key: string, status: EvidenceStatus) => {
    let map = bySource.get(source);
    if (!map) {
      map = new Map();
      bySource.set(source, map);
    }
    // Prefer checked over weaker statuses if called multiple times.
    const prev = map.get(key);
    if (prev === "checked") return;
    if (status === "checked" || !prev) map.set(key, status);
  };

  for (const row of journal) {
    const status = statusFromToolRow(row);
    if (row.name === "get_recalls_complaints") {
      const mmy = mmyFromArgs(row.args);
      if (mmy) touch("recalls_complaints", mmyKey(mmy.year, mmy.make, mmy.model), status);
    } else if (row.name === "get_safety_ratings") {
      const mmy = mmyFromArgs(row.args);
      if (mmy) touch("safety_ratings", mmyKey(mmy.year, mmy.make, mmy.model), status);
    } else if (row.name === "get_vin_decode") {
      for (const vin of vinsFromArgs(row.args)) touch("vin_decode", vin, status);
    } else if (row.name === "get_fuel_economy") {
      for (const vin of vinsFromArgs(row.args)) touch("fuel_economy", vin, status);
      // Also accept MMY-shaped calls if SERV used year/make/model.
      const mmy = mmyFromArgs(row.args);
      if (mmy) touch("fuel_economy", mmyKey(mmy.year, mmy.make, mmy.model), status);
    } else if (row.name === "get_market_comps") {
      const mm = makeModelFromArgs(row.args);
      if (mm) touch("market_comps", makeModelKey(mm.make, mm.model), status);
    } else if (row.name === "get_flip_pnl") {
      for (const vin of vinsFromArgs(row.args)) touch("flip_pnl", vin, status);
    }
  }

  return { bySource };
}

function coverageKeysForSource(
  source: EvidenceSourceId,
  listing: EvidenceListingFact,
): string[] {
  const vin = listing.vin.toUpperCase();
  switch (source) {
    case "vin_decode":
    case "flip_pnl":
      return [vin];
    case "fuel_economy":
      return [vin, mmyKey(listing.year, listing.make, listing.model)];
    case "recalls_complaints":
    case "safety_ratings":
      return [mmyKey(listing.year, listing.make, listing.model)];
    case "market_comps":
      return [makeModelKey(listing.make, listing.model)];
  }
}

export function sourcesForPick(input: {
  listing: EvidenceListingFact;
  index: EvidenceAttemptIndex;
  requiredSources: readonly EvidenceSourceId[];
}): EvidenceSourceRow[] {
  const rows: EvidenceSourceRow[] = [];
  for (const source of input.requiredSources) {
    const keys = coverageKeysForSource(source, input.listing);
    const map = input.index.bySource.get(source);
    let status: EvidenceStatus = "not_checked";
    if (map) {
      for (const key of keys) {
        const hit = map.get(key);
        if (!hit) continue;
        if (hit === "checked") {
          status = "checked";
          break;
        }
        // Prefer empty over error/unavailable when multiple keys hit.
        if (status === "not_checked" || (hit === "empty" && status !== "empty")) {
          status = hit;
        }
      }
    }
    rows.push({
      source,
      status,
      label: EVIDENCE_SOURCE_LABELS[source],
    });
  }
  return rows;
}

export function missingEvidenceSources(rows: readonly EvidenceSourceRow[]): EvidenceSourceId[] {
  return rows.filter((r) => r.status === "not_checked").map((r) => r.source);
}

/** Count prior submit_picks rejections that cited evidence gaps (one-repair budget). */
export function evidenceRepairAlreadySent(
  journal: readonly { kind?: string; name?: string; ok?: boolean; summary?: string }[],
): boolean {
  for (const entry of journal) {
    if (entry.kind !== "tool") continue;
    if (entry.name !== "submit_picks") continue;
    if (entry.ok !== false) continue;
    if (/evidence_incomplete|evidence gate|not checked.*source|attempt each source/i.test(entry.summary ?? "")) {
      return true;
    }
  }
  return false;
}

export function evaluateEvidenceGate(input: {
  picks: ReadonlyArray<{ vin: string }>;
  listingsByVin: ReadonlyMap<string, EvidenceListingFact>;
  journal: readonly EvidenceJournalToolRow[];
  requiredSources: readonly EvidenceSourceId[];
  /** True when a prior submit_picks already repaired for missing evidence. */
  repairAlreadySent: boolean;
}):
  | {
      ok: true;
      byVin: Record<string, EvidenceSourceRow[]>;
      acceptedWithGaps: boolean;
    }
  | {
      ok: false;
      issues: Array<{ field: string; message: string }>;
      byVin: Record<string, EvidenceSourceRow[]>;
    } {
  const index = buildEvidenceAttemptIndex(input.journal);
  const byVin: Record<string, EvidenceSourceRow[]> = {};
  const issues: Array<{ field: string; message: string }> = [];

  for (const [i, pick] of input.picks.entries()) {
    const vin = pick.vin.toUpperCase();
    const listing = input.listingsByVin.get(vin);
    if (!listing) {
      // VIN invent gate owns this — skip evidence for unknown listings.
      byVin[vin] = input.requiredSources.map((source) => ({
        source,
        status: "not_checked" as const,
        label: EVIDENCE_SOURCE_LABELS[source],
      }));
      continue;
    }
    const rows = sourcesForPick({
      listing: { ...listing, vin },
      index,
      requiredSources: input.requiredSources,
    });
    byVin[vin] = rows;
    const missing = missingEvidenceSources(rows);
    if (missing.length > 0 && !input.repairAlreadySent) {
      issues.push({
        field: `picks[${i}].evidence`,
        message: `Evidence gate: VIN ${vin} is missing attempts for ${missing
          .map((s) => EVIDENCE_SOURCE_LABELS[s])
          .join(", ")}. Call each source tool once for this finalist (batched VIN lists OK), then submit_picks again. Empty/error/unavailable outcomes still count — do not skip the call.`,
      });
    } else if (missing.length > 0 && input.repairAlreadySent) {
      // Accept — leave status as not_checked for the card.
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues, byVin };
  }

  const acceptedWithGaps = Object.values(byVin).some((rows) =>
    rows.some((r) => r.status === "not_checked"),
  );
  return { ok: true, byVin, acceptedWithGaps };
}

export function formatSourcesCheckedLine(rows: readonly EvidenceSourceRow[]): string {
  if (rows.length === 0) return "";
  return `Sources: ${rows.map((r) => `${r.label} (${r.status.replace(/_/g, " ")})`).join(" · ")}`;
}

/** Journal rows suitable for the gate (tool calls only). */
export function evidenceJournalFromAgentJournal(
  journal: readonly {
    kind: string;
    name?: string;
    args?: unknown;
    ok?: boolean;
    summary?: string;
    result?: unknown;
  }[],
): EvidenceJournalToolRow[] {
  const out: EvidenceJournalToolRow[] = [];
  for (const entry of journal) {
    if (entry.kind !== "tool" || typeof entry.name !== "string") continue;
    out.push({
      name: entry.name,
      args: entry.args ?? null,
      ok: entry.ok !== false,
      summary: entry.summary,
      result: entry.result,
    });
  }
  return out;
}
