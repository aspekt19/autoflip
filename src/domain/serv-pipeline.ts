/**
 * Public pipeline map for the "Where SERV runs" page.
 * Execution evidence is shown separately from this implementation map.
 */

export type ServPipelineStep = {
  id: string;
  surface: "Find" | "Check" | "Resale" | "Deal Radar" | "Report";
  name: string;
  by: "SERV" | "code";
  detail: string;
};

export const PIPELINE_STEPS: readonly ServPipelineStep[] = [
  {
    id: "find_intake",
    surface: "Find",
    name: "Intake and brief confirmation",
    by: "SERV",
    detail: "Interprets the shopper's note, asks for missing material details, and submits a structured brief for the shopper to confirm before inventory search.",
  },
  {
    id: "find_search",
    surface: "Find",
    name: "Search and evidence-tool selection",
    by: "SERV",
    detail: "Chooses when to search inventory, paginate, and request VIN, recall, safety, fuel-economy, or market-comparison evidence.",
  },
  {
    id: "find_execute",
    surface: "Find",
    name: "Provider lookups and validation",
    by: "code",
    detail: "Executes the selected application tools, normalizes provider results, records source provenance, and validates VINs, distances, budgets, and hard shopper constraints.",
  },
  {
    id: "find_settle",
    surface: "Find",
    name: "Candidate review and terminal decision",
    by: "SERV",
    detail: "Reviews returned candidates and submits a shortlist or a reasoned nothing-fits result. Code checks the submitted VINs and constraints before the result is delivered.",
  },
  {
    id: "check_extract",
    surface: "Check",
    name: "Read the listing",
    by: "SERV",
    detail: "Extracts missing year, make, model, or listing fields when they are not already supplied; known fields skip this step.",
  },
  {
    id: "check_price",
    surface: "Check",
    name: "Price and evidence calculations",
    by: "code",
    detail: "Computes market-price context and price badges from comparable asking prices, and runs deterministic VIN, recall, safety, and other available evidence checks.",
  },
  {
    id: "check_verdict",
    surface: "Check",
    name: "Shopper verdict and second review",
    by: "SERV",
    detail: "Reviews the calculated facts and can challenge the first verdict. Dollar amounts remain those computed by the application.",
  },
  {
    id: "resale_plan",
    surface: "Resale",
    name: "Plan the search",
    by: "SERV",
    detail: "Chooses an allowed budget-first or constraint-specific inventory search plan after the shopper confirms the brief.",
  },
  {
    id: "resale_pnl",
    surface: "Resale",
    name: "Acquisition and resale economics",
    by: "code",
    detail: "Calculates taxes, fees, title costs, reconditioning allowance, expected resale and profit; SERV receives these figures rather than inventing them.",
  },
  {
    id: "resale_pick",
    surface: "Resale",
    name: "Candidate selection and challenge",
    by: "SERV",
    detail: "Selects among shortlisted vehicles using code-computed P&L and applies a second-look challenge to the proposed pick.",
  },
  {
    id: "radar_guard",
    surface: "Deal Radar",
    name: "Saved-search review",
    by: "SERV",
    detail: "Screens saved-search criteria before a monitoring cycle proceeds.",
  },
  {
    id: "radar_price_gate",
    surface: "Deal Radar",
    name: "Price-evidence gate",
    by: "code",
    detail: "Calculates comparable-price evidence. Candidates without enough verified price evidence are not sent to SERV for an alert decision.",
  },
  {
    id: "radar_judge",
    surface: "Deal Radar",
    name: "Alert or skip decision",
    by: "SERV",
    detail: "Reviews eligible candidates and decides whether to alert or skip. An optional challenge adds a second look; failed or unusable SERV reviews do not create an alert.",
  },
  {
    id: "report_gates",
    surface: "Report",
    name: "Safety and consistency gates",
    by: "code",
    detail: "Checks hard safety conditions, title evidence and VIN/listing consistency before a suggested action can be shown.",
  },
  {
    id: "report_verdict",
    surface: "Report",
    name: "Full-report verdict",
    by: "SERV",
    detail: "Reviews the sealed calculated facts and produces the shopper-facing verdict; a separate challenge profile can second-check the decision.",
  },
] as const;
