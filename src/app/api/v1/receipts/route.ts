/**
 * GET /api/v1/receipts — recent agent call receipts for this af_ key's account.
 */
import { getKv } from "@/io/kv";
import { authenticateAgentRequest, authFailureResponse } from "@/server/agent-auth";
import { listAgentReceiptIds, publicAgentReceipt, readAgentReceipt } from "@/server/agent-receipts";
import { originOf } from "@/server/secrets";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const origin = originOf(request);
  const kv = getKv();
  const auth = await authenticateAgentRequest(kv, request, origin, "read");
  if (!auth.ok) return authFailureResponse(auth);

  const ids = await listAgentReceiptIds(kv, auth.caller.userId, 25);
  const receipts = [];
  for (const id of ids) {
    const row = await readAgentReceipt(kv, id);
    if (row && row.user_id === auth.caller.userId) receipts.push(publicAgentReceipt(row));
  }
  return Response.json({ receipts, credit_spent: false }, { headers: auth.headers });
}
