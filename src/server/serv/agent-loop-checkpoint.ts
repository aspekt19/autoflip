/**
 * Serializable mid-loop state for agentic Find/Resale SERV tool loops.
 * Persisted between HTTP requests so a Hobby 300s cap cannot kill a multi-round
 * run mid-flight — rounds continue on the next decide/step/status call.
 *
 * Journal/rejection rows stay structurally typed as plain records here so this
 * module does not import the Find/Resale loop files (avoids cycles).
 */
import type { Listing } from "@/domain/types";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import type { ResponsesInputItem } from "@/server/serv/agent-tool-loop-protocol";
import type { ServChatTurnMessage } from "@/server/serv/agent-chat-turn";

export type AgentLoopModePhase = "tools" | "next_action";

export type AgentLoopCheckpointV1 = {
  v: 1;
  product: "find" | "resale";
  phase: AgentLoopModePhase;
  toolRounds: number;
  /** Completed SERV rounds in this loop (0-based next round index). */
  roundsCompleted: number;
  /** Responses multi-turn input (reasoning + function_call + outputs). */
  responsesInput: ResponsesInputItem[];
  /** Chat transcript for next_action / tools safety-net finish. */
  messages: ServChatTurnMessage[];
  /** FindAgentJournalEntry[] / ResaleAgentJournalEntry[] at the call site. */
  journal: Array<Record<string, unknown>>;
  knownVins: string[];
  listingsByVin: Array<[string, Listing]>;
  /** Resale-only flip PnL rows keyed by VIN. */
  pnlByVin?: Array<[string, ResaleCandidatePnl]>;
  submitNudgeSent: boolean;
  firstTurn: boolean;
  featureRejections: Array<Record<string, unknown>>;
  /** SERV-extracted chat facts (budget/ZIP/radius) for anti-fab. */
  shopperFacts?: {
    budgetUsd: number | null;
    zip: string | null;
    radiusMi: number | null;
  };
  /** Pending ask_shopper call_id while waiting for the shopper reply. */
  pendingAskCallId?: string | null;
  pendingAskQuestion?: string | null;
};

export type AgentLoopCheckpoint = AgentLoopCheckpointV1;

export function serializeListingsByVin(
  map: Map<string, Listing>,
): Array<[string, Listing]> {
  return [...map.entries()];
}

export function deserializeListingsByVin(
  rows: ReadonlyArray<[string, Listing]> | undefined,
): Map<string, Listing> {
  const out = new Map<string, Listing>();
  if (!rows) return out;
  for (const [vin, listing] of rows) {
    if (typeof vin === "string" && listing && typeof listing === "object") {
      out.set(vin.toUpperCase(), listing);
    }
  }
  return out;
}

export function serializePnlByVin(
  map: Map<string, ResaleCandidatePnl>,
): Array<[string, ResaleCandidatePnl]> {
  return [...map.entries()];
}

export function deserializePnlByVin(
  rows: ReadonlyArray<[string, ResaleCandidatePnl]> | undefined,
): Map<string, ResaleCandidatePnl> {
  const out = new Map<string, ResaleCandidatePnl>();
  if (!rows) return out;
  for (const [vin, pnl] of rows) {
    if (typeof vin === "string" && pnl && typeof pnl === "object") {
      out.set(vin.toUpperCase(), pnl);
    }
  }
  return out;
}

export function isAgentLoopCheckpoint(value: unknown): value is AgentLoopCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.v === 1 &&
    (row.product === "find" || row.product === "resale") &&
    (row.phase === "tools" || row.phase === "next_action") &&
    typeof row.toolRounds === "number" &&
    typeof row.roundsCompleted === "number" &&
    Array.isArray(row.responsesInput) &&
    Array.isArray(row.messages) &&
    Array.isArray(row.journal) &&
    Array.isArray(row.knownVins) &&
    Array.isArray(row.listingsByVin)
  );
}
