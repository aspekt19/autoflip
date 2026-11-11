/**
 * How structured radar criteria were derived from free text (or form-only).
 * Never invent a provider response id — null means none to show.
 */

import type { Mode } from "./types";
import type { WatchCriteria } from "./radar-watch";
import { formatUsd } from "./format";

export type CriteriaParseSource = "serv" | "code" | "form";

export type CriteriaParseProvenance = {
  source: CriteriaParseSource;
  /** Provider response id when SERV parsed the free text; null otherwise. */
  responseId: string | null;
};

export function criteriaParseLabel(parse: CriteriaParseProvenance | null | undefined): string {
  if (!parse) return "How these filters were read is not on this record.";
  if (parse.source === "form") return "Typed in the form.";
  return "Read from your note.";
}

/** Response ids stay out of the main card. Null when there is nothing honest to add. */
export function criteriaParseTechnicalLine(parse: CriteriaParseProvenance | null | undefined): string | null {
  if (!parse || parse.source === "form") return null;
  if (parse.source === "serv") {
    return parse.responseId
      ? `Review response ${parse.responseId}`
      : "Read from your note. No response id was recorded.";
  }
  return "Read by built-in rules. No paid review ran.";
}

/** Full buyer-facing criteria source line for Deal Radar watch cards. */
export function criteriaSourceLine(input: {
  parse: CriteriaParseProvenance | null | undefined;
  origin?: "find" | "resale" | "fields" | null;
  originSearchId?: string | null;
  freeText?: string | null;
}): string {
  const origin =
    input.origin === "find"
      ? "From Find"
      : input.origin === "resale"
        ? "From Resale"
        : input.origin === "fields"
          ? "From the form"
          : null;
  const how = input.freeText?.trim() ? "your note" : "the fields you entered";
  const parse = criteriaParseLabel(input.parse);
  if (!origin) return parse;
  return `${origin}, using ${how}. ${parse}`;
}

/** Search ids are internal. Show them only inside technical details. */
export function criteriaSourceTechnicalLine(input: {
  parse: CriteriaParseProvenance | null | undefined;
  originSearchId?: string | null;
}): string | null {
  const parts: string[] = [];
  const parse = criteriaParseTechnicalLine(input.parse);
  if (parse) parts.push(parse);
  const id = input.originSearchId?.trim();
  if (id) parts.push(`Search ${id}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Short human summary for subscription cards (existing + new watches). */
export function watchCriteriaSummary(criteria: WatchCriteria, mode: Mode): string {
  const parts: string[] = [];
  parts.push(`up to ${formatUsd(criteria.priceMax)}`);
  if (criteria.zip?.trim()) {
    const radius =
      mode === "flip" && (!criteria.radiusMiles || criteria.radiusMiles <= 0)
        ? "nationwide"
        : `${criteria.radiusMiles} mi`;
    parts.push(`near ${criteria.zip.trim()}, ${radius}`);
  } else if (mode === "flip") {
    parts.push("nationwide");
  }
  const models = criteria.models?.length
    ? criteria.models.map((m) => `${m.make} ${m.model}`.trim()).join(", ")
    : [criteria.make, criteria.model].filter(Boolean).join(" ");
  if (models) parts.push(models);
  if (criteria.bodyStyle) parts.push(criteria.bodyStyle.replace(/_/g, " "));
  if (criteria.yearMin || criteria.yearMax) {
    parts.push(
      criteria.yearMin && criteria.yearMax
        ? `${criteria.yearMin}–${criteria.yearMax}`
        : criteria.yearMin
          ? `${criteria.yearMin}+`
          : `through ${criteria.yearMax}`,
    );
  }
  if (criteria.milesMax != null) parts.push(`≤${criteria.milesMax.toLocaleString("en-US")} mi`);
  if (criteria.freeText?.trim()) parts.push(`“${criteria.freeText.trim().slice(0, 80)}${criteria.freeText.trim().length > 80 ? "…" : ""}”`);
  else if (criteria.notes?.trim()) parts.push(`notes: ${criteria.notes.trim().slice(0, 60)}`);
  return parts.join(" · ");
}
