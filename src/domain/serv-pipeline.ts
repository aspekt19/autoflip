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
    name: "Need parse",
    by: "SERV",
    detail: "Reads the free-text need; code clamps fields to allowlisted criteria.",
  },
  {
    id: "find_rank",
    surface: "Find",
    name: "Rank shortlist",
    by: "code",
    detail: "Asking prices, comps, and pick order stay in TypeScript.",
  },
  {
    id: "find_next_check",
    surface: "Find",
    name: "Next check choice",
    by: "SERV",
    detail: "Chooses the next allowlisted check; code runs it and records evidence.",
  },
  {
    id: "find_settle",
    surface: "Find",
    name: "Settle Buy / Negotiate / Pass",
    by: "SERV",
    detail: "Chooses an action from code facts; a second check must agree or confidence drops.",
  },
  {
    id: "check_extract",
    surface: "Check",
    name: "Listing extract",
    by: "SERV",
    detail: "Optional when year/make/model are missing; skipped when already parsed.",
  },
  {
    id: "check_price",
    surface: "Check",
    name: "Price badge & comps",
    by: "code",
    detail: "Fair value and Good / Fair / High badges are calculated in code.",
  },
  {
    id: "check_verdict",
    surface: "Check",
    name: "Shopper verdict",
    by: "SERV",
    detail: "Decide + second check under ordered gates. Numbers stay quoted from code.",
  },
  {
    id: "resale_plan",
    surface: "Resale",
    name: "Plan / triage / pick",
    by: "SERV",
    detail: "Plans the search and picks among allowlisted VINs; profit and loss figures stay in code.",
  },
  {
    id: "resale_challenge",
    surface: "Resale",
    name: "Pick challenge",
    by: "SERV",
    detail: "Independent second look at the pick; disagreement lowers confidence.",
  },
  {
    id: "report_gates",
    surface: "Report",
    name: "Ordered safety gates",
    by: "code",
    detail: "Park-it, title risk, and VIN identity gates can withhold any model action.",
  },
  {
    id: "report_verdict",
    surface: "Report",
    name: "Full-report verdict",
    by: "SERV",
    detail: "Same decide + challenge path as Check, after code has sealed the figures.",
  },
] as const;
