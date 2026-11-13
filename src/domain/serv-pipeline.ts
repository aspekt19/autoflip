/**
 * Static pipeline map for the public "Where SERV runs" page.
 * Labels only — live counts come from sealed audit stats, never from this file.
 */

export type ServPipelineStep = {
  id: string;
  surface: "Find" | "Check" | "Resale" | "Report";
  name: string;
  by: "SERV" | "code";
  detail: string;
};

export const PIPELINE_STEPS: readonly ServPipelineStep[] = [
  {
    id: "find_intake",
    surface: "Find",
    name: "Intake chat",
    by: "SERV",
    detail: "The chat asks for the brief, then submits it for you to confirm before any search.",
  },
  {
    id: "find_search",
    surface: "Find",
    name: "Search and evidence",
    by: "SERV",
    detail: "After you confirm, the same chat calls listing and public-record tools. A missing source does not stop the search.",
  },
  {
    id: "find_settle",
    surface: "Find",
    name: "Pick or nothing fits",
    by: "SERV",
    detail: "The chat submits the cars or says nothing fits. The calculation checks budget, radius, and a no-accident rule, and keeps the journal.",
  },
  {
    id: "check_extract",
    surface: "Check",
    name: "Read the listing",
    by: "SERV",
    detail: "Used only when year, make, or model is missing. Skipped when those are already known.",
  },
  {
    id: "check_price",
    surface: "Check",
    name: "Price badge",
    by: "code",
    detail: "Fair value and the Good, Fair, or High badge are calculated from similar cars for sale nearby.",
  },
  {
    id: "check_verdict",
    surface: "Check",
    name: "Shopper verdict",
    by: "SERV",
    detail: "A first review and a second review, after the safety checks. Dollar amounts stay the ones already calculated.",
  },
  {
    id: "resale_plan",
    surface: "Resale",
    name: "Plan the search and pick",
    by: "SERV",
    detail: "Plans the search and picks among the cars already on the shortlist. Profit figures stay in the calculation.",
  },
  {
    id: "resale_challenge",
    surface: "Resale",
    name: "Second look at the pick",
    by: "SERV",
    detail: "An independent second look at the pick. Disagreement lowers confidence.",
  },
  {
    id: "report_gates",
    surface: "Report",
    name: "Safety checks",
    by: "code",
    detail: "A do-not-drive recall, a title problem, or a VIN that does not match the listing can withhold any suggested action.",
  },
  {
    id: "report_verdict",
    surface: "Report",
    name: "Full-report verdict",
    by: "SERV",
    detail: "The same two-step review as Check a car, after the figures are sealed.",
  },
] as const;
