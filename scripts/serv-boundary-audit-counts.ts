/**
 * SERV boundary audit honesty: count decision-point fates from partial markdown
 * rows, then compare to the summary tables so docs cannot drift.
 *
 * Primary fate only — first bold fate tag per countable row.
 * Buckets: removed | moved | kept. `still present` (primary) → removed (target).
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type FateBucket = "removed" | "moved" | "kept";

export type FateCounts = {
  found: number;
  removed: number;
  moved: number;
  kept: number;
};

export const AUDIT_PARTIALS = [
  {
    key: "find" as const,
    file: "docs/serv-boundary-audit-find.md",
    label: "Find (`serv-boundary-audit-find.md`)",
  },
  {
    key: "resale" as const,
    file: "docs/serv-boundary-audit-resale-radar-api.md",
    label: "Resale / Radar / v1 / MCP (`serv-boundary-audit-resale-radar-api.md`)",
  },
  {
    key: "check" as const,
    file: "docs/serv-boundary-audit-check.md",
    label: "Check (`serv-boundary-audit-check.md`)",
  },
] as const;

export const MAIN_AUDIT = "docs/serv-boundary-audit.md";

const FATE_BOLD = /\*\*([^*]+)\*\*/g;

export function emptyCounts(): FateCounts {
  return { found: 0, removed: 0, moved: 0, kept: 0 };
}

export function sumCounts(parts: FateCounts[]): FateCounts {
  const out = emptyCounts();
  for (const c of parts) {
    out.found += c.found;
    out.removed += c.removed;
    out.moved += c.moved;
    out.kept += c.kept;
  }
  return out;
}

function classifyToken(raw: string): FateBucket | null {
  const low = raw.trim().toLowerCase();
  // Verified-status tag whose structural target is remove (see partial fate keys).
  if (/^still present\b/.test(low)) return "removed";
  if (/^removed\b/.test(low)) return "removed";
  if (/^moved into serv\b/.test(low)) return "moved";
  if (/^kept as guardrail\b/.test(low)) return "kept";
  if (low === "kept") return "kept";
  return null;
}

/** First bold fate tag on the row (prefer text after `fate:` / `proposed fate:`). */
export function primaryFate(line: string): FateBucket | null {
  const fateMatch = line.match(/(?:proposed\s+)?fate:\s*/i);
  const region = fateMatch ? line.slice(fateMatch.index! + fateMatch[0].length) : line;
  FATE_BOLD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FATE_BOLD.exec(region))) {
    const bucket = classifyToken(m[1]);
    if (bucket) return bucket;
  }
  if (fateMatch) {
    FATE_BOLD.lastIndex = 0;
    while ((m = FATE_BOLD.exec(line))) {
      const bucket = classifyToken(m[1]);
      if (bucket) return bucket;
    }
  }
  return null;
}

function isMetaCountsRow(line: string): boolean {
  return (
    /^\|\s*\*\*(found|removed|moved|kept|total)/i.test(line) ||
    /^\|\s*(found|removed|moved|kept|total decision|bullet rows|total fate|suggested )/i.test(
      line,
    ) ||
    /^\|\s*Fate\s*\|/i.test(line) ||
    /^\|\s*Metric\s*\|/i.test(line) ||
    /^\|\s*Surface\s*\|/i.test(line)
  );
}

/** Count primary fates from bullets (+ Check product-rule table rows). */
export function countPartialMarkdown(text: string, fileName: string): FateCounts {
  const counts = emptyCounts();
  const isCheck = basename(fileName) === "serv-boundary-audit-check.md";
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (isMetaCountsRow(t)) continue;
    let countable = false;
    if (t.startsWith("- ")) countable = true;
    else if (isCheck && t.startsWith("|") && !/^\|\s*-+/.test(t) && /^\|\s*\d+\s*\|/.test(t)) {
      countable = true;
    }
    if (!countable) continue;
    const fate = primaryFate(t);
    if (!fate) continue;
    counts.found += 1;
    counts[fate] += 1;
  }
  return counts;
}

export function countPartialFile(repoRoot: string, relativePath: string): FateCounts {
  const abs = join(repoRoot, relativePath);
  return countPartialMarkdown(readFileSync(abs, "utf8"), relativePath);
}

export function countAllPartials(repoRoot: string): {
  byKey: Record<(typeof AUDIT_PARTIALS)[number]["key"], FateCounts>;
  total: FateCounts;
} {
  const byKey = {} as Record<(typeof AUDIT_PARTIALS)[number]["key"], FateCounts>;
  const parts: FateCounts[] = [];
  for (const partial of AUDIT_PARTIALS) {
    const c = countPartialFile(repoRoot, partial.file);
    byKey[partial.key] = c;
    parts.push(c);
  }
  return { byKey, total: sumCounts(parts) };
}

function parseIntCell(raw: string): number | null {
  const m = raw.replace(/\*/g, "").replace(/,/g, "").trim().match(/^-?\d+$/);
  return m ? Number(m[0]) : null;
}

/**
 * Parse a partial's trailing ## Counts table into FateCounts.
 * Supports Find (Metric/Count), Resale/Check (Fate/Count) shapes.
 */
export function parsePartialCountsTable(text: string): FateCounts | null {
  const section = text.split(/^## Counts\s*$/m)[1];
  if (!section) return null;
  const body = section.split(/^## /m)[0] ?? section;
  const out = emptyCounts();
  let saw = false;
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const parts = t
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (parts.length < 2) continue;
    if (/^-+$/.test(parts[0].replace(/:/g, "")) || /^(metric|fate)$/i.test(parts[0].replace(/\*/g, ""))) {
      continue;
    }
    const label = parts[0].replace(/\*/g, "").toLowerCase();
    const n = parseIntCell(parts[1]);
    if (n == null) continue;
    if (/^found\b/.test(label) || /^total decision points/.test(label) || label === "total") {
      out.found = n;
      saw = true;
    } else if (/removed/.test(label)) {
      out.removed = n;
      saw = true;
    } else if (/moved/.test(label)) {
      out.moved = n;
      saw = true;
    } else if (/kept/.test(label)) {
      out.kept = n;
      saw = true;
    }
  }
  // Find table lists found explicitly; Resale lists total separately — if found unset, sum buckets.
  if (saw && out.found === 0) {
    out.found = out.removed + out.moved + out.kept;
  }
  return saw ? out : null;
}

/** Parse the main audit Summary counts (partial targets) table (per-surface + Total). */
export function parseMainSummaryTable(text: string): {
  rows: { label: string; counts: FateCounts }[];
  total: FateCounts | null;
} {
  const section = text.split(/^## Summary counts \(partial targets\)\s*$/m)[1];
  if (!section) return { rows: [], total: null };
  const body = section.split(/^### /m)[0] ?? section;
  const rows: { label: string; counts: FateCounts }[] = [];
  let total: FateCounts | null = null;
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const parts = t
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (parts.length < 5) continue;
    const label = parts[0].replace(/\*/g, "").trim();
    if (/^surface$/i.test(label) || /^-+/.test(label.replace(/:/g, ""))) continue;
    const found = parseIntCell(parts[1]);
    const removed = parseIntCell(parts[2]);
    const moved = parseIntCell(parts[3]);
    const kept = parseIntCell(parts[4]);
    if (found == null || removed == null || moved == null || kept == null) continue;
    const counts = { found, removed, moved, kept };
    if (/^total$/i.test(label)) total = counts;
    else rows.push({ label: parts[0].trim(), counts });
  }
  return { rows, total };
}

/** Stale hardcoded verified rollups that must not appear (can disagree with rows). */
export const STALE_VERIFIED_SUMMARY_RE =
  /\*\*Removed \(verified this branch\):\*\*\s*\*\*\d+\*\*|\bverified\s+139\b|\b139\*\*.*\b85\*\*.*\b209\b/i;

export function assertCountsEqual(actual: FateCounts, expected: FateCounts, label: string): void {
  const keys: (keyof FateCounts)[] = ["found", "removed", "moved", "kept"];
  for (const k of keys) {
    if (actual[k] !== expected[k]) {
      throw new Error(
        `${label}: ${k} mismatch — rows/computed=${actual[k]} summary=${expected[k]} ` +
          `(computed ${JSON.stringify(actual)} vs summary ${JSON.stringify(expected)})`,
      );
    }
  }
}
