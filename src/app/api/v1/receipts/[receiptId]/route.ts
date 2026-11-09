/**
 * GET /api/v1/receipts/:receiptId — one agent call receipt.
 */
import { getKv } from "@/io/kv";
import { authenticateAgentRequest, authFailureResponse } from "@/server/agent-auth";
import { agentError, jsonError } from "@/server/agent-envelope";
import { readAgentReceipt } from "@/server/agent-receipts";
import { originOf } from "@/server/secrets";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ receiptId: string }> };

export async function GET(request: Request, ctx: Ctx) {
  const origin = originOf(request);
  const kv = getKv();
  const auth = await authenticateAgentRequest(kv, request, origin, "read");
  if (!auth.ok) return authFailureResponse(auth);

  const { receiptId } = await ctx.params;
  const receipt = await readAgentReceipt(kv, receiptId);
  if (!receipt || receipt.user_id !== auth.caller.userId) {
    return jsonError(
      404,
      agentError({
        error_code: "receipt_not_found",
        message: "No receipt with that id for this API key.",
        next_steps: {
          action: "list_receipts",
          summary: `GET ${origin}/api/v1/receipts for recent calls.`,
          request: { method: "GET", url: `${origin}/api/v1/receipts` },
        },
      }),
    );
  }
  return Response.json({ ...receipt, credit_spent: receipt.credit_spent });
}
