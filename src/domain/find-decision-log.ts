/**
 * Decision log for one Find.
 * Every hop records who chose the check and whether the pick moved.
 * Buyer lines are plain English — no check ids, reason tags, or URLs.
 */

export type FindDecisionRank = {
  key: string;
  rank: number;
};

export type FindDecisionLogEntry = {
  hop: number;
  decidedBy: "SERV" | "code";
  invokeReason: string;
  /** Allowlisted check id. Buyer UI must format this, never print it. */
  action: string;
  /** Car keys the check ran on (empty when the check is not per-car). */
  targetCars: string[];
  /** Plain sentences about what the check added. */
  evidenceAdded: string[];
  top5Before: FindDecisionRank[];
  top5After: FindDecisionRank[];
  pickBefore: string | null;
  pickAfter: string | null;
};

export type DecisionCarLabel = {
  key: string;
  year: number;
  make: string;
  model: string;
};

const ACTION_PLAIN: Record<string, string> = {
  free_car_consistency: "Compared the listing with government vehicle specs",
  free_gov_recalls: "Checked government recall records",
  free_gov_vpic: "Looked up government vehicle specs",
  free_gov_safety: "Checked government crash-test ratings",
  free_gov_fuel: "Checked estimated fuel cost",
  compare_observed_asks: "Compared asking prices",
  clarify_year_band: "Asked for a clearer model-year range",
  clarify_miles_cap: "Asked for a mileage limit",
  set_budget: "Still need a maximum price",
  widen_or_nationwide: "Widened the search distance",
  run_full_analysis: "A full per-car analysis is ready if you want it",
  get_history_report: "A paid history report is the next step if you want accidents and title brands",
};

function carName(label: DecisionCarLabel | undefined): string {
  if (!label) return "one of the cars";
  return `${label.year} ${label.make} ${label.model}`;
}

function joinCars(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function formatDecisionLogLine(
  entry: FindDecisionLogEntry,
  labels: readonly DecisionCarLabel[],
): string {
  const byKey = new Map(labels.map((row) => [row.key, row]));
  const name = (key: string) => carName(byKey.get(key));
  const who = entry.decidedBy === "SERV" ? "AI chose" : "built-in checklist";
  const targets = entry.targetCars.map((key) => name(key));
  const uniqueTargets = [...new Set(targets)].slice(0, 3);
  const action = ACTION_PLAIN[entry.action] ?? "Updated the search checks";
  const onCars = uniqueTargets.length > 0 ? ` on ${joinCars(uniqueTargets)}` : "";
  const evidence = entry.evidenceAdded
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 2);
  const moves: string[] = [];
  const before = new Map(entry.top5Before.map((row) => [row.key, row.rank]));
  const after = new Map(entry.top5After.map((row) => [row.key, row.rank]));
  for (const [key, rank] of after) {
    const prev = before.get(key);
    if (prev != null && prev !== rank) moves.push(`${name(key)} moved from #${prev} to #${rank}`);
  }
  for (const [key, rank] of before) {
    if (!after.has(key)) moves.push(`${name(key)} left the top group (was #${rank})`);
  }
  if (entry.pickBefore !== entry.pickAfter) {
    moves.push(entry.pickAfter ? `the pick is now the ${name(entry.pickAfter)}` : "there is no confident pick now");
  }
  const moveBit = moves.length > 0 ? `${moves.slice(0, 2).join("; ")}.` : "The order of the top cars stayed the same.";
  const evidenceBit = evidence.length > 0 ? `${evidence.join(" ")} ` : "";
  return `${action}${onCars} (${who}). ${evidenceBit}${moveBit}`.replace(/\s+/g, " ").trim();
}

export function formatDecisionLogForBuyer(
  log: readonly FindDecisionLogEntry[],
  labels: readonly DecisionCarLabel[],
  maxLines = 8,
): string[] {
  const slice = log.length > maxLines ? log.slice(log.length - maxLines) : [...log];
  return slice.map((entry) => formatDecisionLogLine(entry, labels));
}

const FREE_LOG_ACTIONS = new Set([
  "free_car_consistency",
  "free_gov_recalls",
  "free_gov_vpic",
  "free_gov_safety",
  "free_gov_fuel",
  "compare_observed_asks",
]);

/** True when this hop changed who is on top or where they sit. */
export function decisionLogRankingChanged(entry: FindDecisionLogEntry): boolean {
  if (entry.pickBefore !== entry.pickAfter) return true;
  const before = new Map(entry.top5Before.map((row) => [row.key, row.rank]));
  const after = new Map(entry.top5After.map((row) => [row.key, row.rank]));
  if (before.size !== after.size) return true;
  for (const [key, rank] of after) {
    if (before.get(key) !== rank) return true;
  }
  return false;
}

export type BuyerDecisionLogView = {
  /** Collapsed checklist runs, plus full lines when the rank moved or AI chose the step. */
  lines: string[];
  /** Individual free-check steps that were folded into a summary. */
  hiddenSteps: string[];
};

/**
 * Consecutive free-check hops that did not move the ranking become one line.
 * Rank changes and AI-chosen steps stay written out. The folded steps are the
 * "show all" list — buyers should not have to read dozens of identical lines.
 */
export function presentDecisionLogForBuyer(
  log: readonly FindDecisionLogEntry[],
  labels: readonly DecisionCarLabel[],
): BuyerDecisionLogView {
  const lines: string[] = [];
  const hiddenSteps: string[] = [];
  type Group = { action: string; who: string; full: string[] };
  let group: Group | null = null;
  const flush = () => {
    if (!group) return;
    if (group.full.length === 1) {
      lines.push(group.full[0]!);
    } else {
      const action = ACTION_PLAIN[group.action] ?? "Updated the search checks";
      lines.push(
        `${action} ${group.full.length} times (${group.who}). The order of the top cars stayed the same.`.replace(
          /\s+/g,
          " ",
        ),
      );
      hiddenSteps.push(...group.full);
    }
    group = null;
  };
  for (const entry of log) {
    const full = formatDecisionLogLine(entry, labels);
    const important = entry.decidedBy === "SERV" || decisionLogRankingChanged(entry);
    const free = FREE_LOG_ACTIONS.has(entry.action);
    if (important || !free) {
      flush();
      lines.push(full);
      continue;
    }
    const who = "built-in checklist";
    if (group && group.action === entry.action && group.who === who) {
      group.full.push(full);
    } else {
      flush();
      group = { action: entry.action, who, full: [full] };
    }
  }
  flush();
  return { lines, hiddenSteps };
}

export function top5Ranks(
  ranked: readonly { key: string }[],
): FindDecisionRank[] {
  return ranked.slice(0, 5).map((row, index) => ({ key: row.key, rank: index + 1 }));
}
