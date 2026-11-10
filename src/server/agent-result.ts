/**
 * Fixed agent API success envelope wrapping Check / Find / report payloads.
 * Reuses lemonless.agent_verdict.v1 when a trail is available.
 */
import {
  AGENT_VERDICT_SCHEMA_VERSION,
  type AgentSecondPassResult,
  type AgentTrailStep,
  type AgentVerdict,
} from "@/domain/agent-verdict-schema";
import type { DecisionProofRecord } from "@/domain/decision-proof-record";
import type { CheckResultPayload } from "@/server/check/run-check";

export type AgentApiSuccess = {
  schema_version: typeof AGENT_VERDICT_SCHEMA_VERSION;
  tool: "check_car" | "find_cars" | "full_report" | "deal_radar";
  verdict: string | null;
  confidence: string | null;
  summary: string | null;
  reasons: Array<{ evidenceId: string; text: string }>;
  risks: Array<{ evidenceId: string; text: string }>;
  unknowns: string[];
  subject: Record<string, unknown> | null;
  comparables_summary: { n: number; method: string; walk_away_usd?: number | null } | null;
  serv: {
    steps: AgentTrailStep[];
    second_pass: AgentSecondPassResult | null;
    checks_run: string[];
    no_serv_step: boolean;
  };
  /** Shared lemonless.decision_proof.v1 — same contract as site Find/Radar. */
  proofRecords: DecisionProofRecord[];
  code_computed: Record<string, number | string | boolean | null>;
  credit_spent: boolean;
  credits: number;
  free_check_spent: boolean;
  receipt_id: string;
  run_id: string | null;
  result: unknown;
};

export function emptyAgentVerdict(partial?: Partial<AgentVerdict>): AgentVerdict {
  return {
    schemaVersion: AGENT_VERDICT_SCHEMA_VERSION,
    pick: null,
    verdict: null,
    reasons: [],
    risks: [],
    confidence: null,
    unknowns: [],
    serv_steps: [],
    second_pass: null,
    multipath: null,
    vs_cheapest: null,
    serv_spend: null,
    no_serv_step: true,
    ...partial,
  };
}

export function agentVerdictFromCheck(check: CheckResultPayload): AgentVerdict {
  const stop = check.redFlags.filter((f) => f.level === "stop");
  const reasons = check.redFlags
    .filter((f) => f.level !== "stop")
    .slice(0, 5)
    .map((f) => ({ evidenceId: f.id, text: f.text }));
  const risks = stop.map((f) => ({ evidenceId: f.id, text: f.text }));
  const confidence =
    check.confidence === "High" ? "high" : check.confidence === "Medium" ? "medium" : check.confidence === "Low" ? "low" : null;
  const action =
    check.verdict === "good_deal"
      ? "buy"
      : check.verdict === "fair"
        ? "negotiate"
        : check.verdict === "overpriced" || check.verdict === "walk_away"
          ? "pass"
          : check.verdict === "dossier"
            ? null
            : "withheld";
  return emptyAgentVerdict({
    verdict: action,
    confidence,
    reasons,
    risks,
    unknowns: check.unknown,
    serv_steps: [
      {
        decided: check.verdictLabel,
        why: check.summary,
        changed: null,
        evidenceIds: check.redFlags.map((f) => f.id).slice(0, 8),
      },
    ],
    no_serv_step: true,
    serv_spend: { calls: 0, costNote: check.llmUsed ? "Listing extract may have used a model call." : null },
  });
}

export function wrapAgentSuccess(input: {
  tool: AgentApiSuccess["tool"];
  verdict: AgentVerdict;
  subject: Record<string, unknown> | null;
  comparables_summary: AgentApiSuccess["comparables_summary"];
  code_computed: AgentApiSuccess["code_computed"];
  checks_run: string[];
  credit_spent: boolean;
  credits: number;
  free_check_spent: boolean;
  receipt_id: string;
  run_id?: string | null;
  summary?: string | null;
  proofRecords?: DecisionProofRecord[];
  result: unknown;
}): AgentApiSuccess {
  return {
    schema_version: AGENT_VERDICT_SCHEMA_VERSION,
    tool: input.tool,
    verdict: input.verdict.verdict,
    confidence: input.verdict.confidence,
    summary: input.summary ?? null,
    reasons: input.verdict.reasons,
    risks: input.verdict.risks,
    unknowns: input.verdict.unknowns,
    subject: input.subject,
    comparables_summary: input.comparables_summary,
    serv: {
      steps: input.verdict.serv_steps,
      second_pass: input.verdict.second_pass,
      checks_run: input.checks_run,
      no_serv_step: input.verdict.no_serv_step,
    },
    proofRecords: input.proofRecords ?? [],
    code_computed: input.code_computed,
    credit_spent: input.credit_spent,
    credits: input.credits,
    free_check_spent: input.free_check_spent,
    receipt_id: input.receipt_id,
    run_id: input.run_id ?? null,
    result: input.result,
  };
}
