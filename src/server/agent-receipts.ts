/**
 * Append-only per-call receipts for agent REST + MCP.
 * Retrievable with the same af_ key (read scope).
 */
import { createHash, randomUUID } from "node:crypto";
import type { Kv } from "@/io/kv";

export type AgentReceipt = {
  receipt_id: string;
  key_id: string;
  key_prefix: string;
  user_id: string;
  tool: string;
  credit_spent: boolean;
  credits: number;
  free_check_spent: boolean;
  serv_steps_hash: string | null;
  created_at: string;
  idempotency_key: string | null;
  run_id: string | null;
  summary: string | null;
};

function receiptKey(id: string): string {
  return `agent:receipt:${id}`;
}

function indexKey(userId: string): string {
  return `agent:receipts:${userId}`;
}

export function hashServSteps(steps: unknown): string | null {
  if (steps == null) return null;
  try {
    return createHash("sha256").update(JSON.stringify(steps)).digest("hex").slice(0, 24);
  } catch {
    return null;
  }
}

export async function writeAgentReceipt(
  kv: Kv,
  input: Omit<AgentReceipt, "receipt_id" | "created_at"> & { receipt_id?: string },
): Promise<AgentReceipt> {
  const receipt: AgentReceipt = {
    receipt_id: input.receipt_id ?? randomUUID(),
    key_id: input.key_id,
    key_prefix: input.key_prefix,
    user_id: input.user_id,
    tool: input.tool,
    credit_spent: input.credit_spent,
    credits: input.credits,
    free_check_spent: input.free_check_spent,
    serv_steps_hash: input.serv_steps_hash,
    created_at: new Date().toISOString(),
    idempotency_key: input.idempotency_key,
    run_id: input.run_id,
    summary: input.summary,
  };
  await kv.set(receiptKey(receipt.receipt_id), JSON.stringify(receipt));
  const raw = await kv.get(indexKey(receipt.user_id));
  let ids: string[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === "string");
    } catch {
      ids = [];
    }
  }
  ids.unshift(receipt.receipt_id);
  await kv.set(indexKey(receipt.user_id), JSON.stringify(ids.slice(0, 200)));
  return receipt;
}

export async function readAgentReceipt(kv: Kv, receiptId: string): Promise<AgentReceipt | null> {
  const raw = await kv.get(receiptKey(receiptId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentReceipt;
  } catch {
    return null;
  }
}

export async function listAgentReceiptIds(kv: Kv, userId: string, limit = 20): Promise<string[]> {
  const raw = await kv.get(indexKey(userId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string").slice(0, limit);
  } catch {
    return [];
  }
}
