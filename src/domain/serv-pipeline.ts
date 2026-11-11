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
    id: "need_parse",
    surface: "Find",
    name: "Read what you need",
    by: "SERV",
    detail: "Reads your note. Only the fields Lemonless already accepts are kept.",
  },
  {
    id: "find_rank",
    surface: "Find",
    name: "Rank the shortlist",
    by: "code",
    detail: "Asking prices, similar cars for sale nearby, and the order of the list stay in the calculation.",
  },
  {
    id: "find_next_check",
    surface: "Find",
    name: "Choose the next check",
    by: "SERV",
    detail: "Chooses the next check from the list Lemonless allows. The check itself is run and saved by the calculation.",
  },
  {
    id: "find_settle",
    surface: "Find",
    name: "Buy, negotiate, or pass",
    by: "SERV",
    detail: "Chooses an action from the calculated facts. A second review must agree, or confidence drops.",
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
