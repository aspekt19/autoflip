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
  if (!parse) return "Criteria source not recorded";
  if (parse.source === "serv") {
    return parse.responseId
      ? `Parsed by SERV · response ${parse.responseId}`
      : "Parsed by SERV · no response id";
  }
  if (parse.source === "code") return "Parsed by code";
  return "Entered on the form";
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
