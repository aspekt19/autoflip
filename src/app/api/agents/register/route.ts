import { getKv } from "@/io/kv";
import { createApiKey, revokeApiKey } from "@/server/api-keys";
import { withX402Payment } from "@/server/x402-payments";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return withX402Payment(request, async ({ payer, paymentId }) => {
    const body = (await request.clone().json().catch(() => null)) as { label?: unknown } | null;
    const label = typeof body?.label === "string" ? body.label.trim().slice(0, 40) : "External AI agent";
    if (!label) {
      return { response: Response.json({ error_code: "invalid_label", message: "label must be a non-empty string.", charged: false }, { status: 400 }) };
    }

    const userId = `agent-wallet:${payer}`;
    const created = await createApiKey(getKv(), userId, label, ["read", "check", "find"]);
    const payload = {
      ok: true,
      owner_wallet: payer,
      api_key: created.token,
      key_id: created.record.id,
      scopes: created.record.scopes,
      auth_header: "Authorization: Bearer " + created.token,
      payment_id: paymentId,
      note: "This API key is shown only once. Store it in your agent's secret store. Revoke it if exposed.",
      next_steps: {
        action: "save_api_key_and_check_balance",
        request: { method: "GET", url: new URL("/api/agents/payment-info", request.url).toString(), headers: { Authorization: "Bearer " + created.token } },
      },
    };

    return {
      response: Response.json(payload),
      rollback: async () => {
        await revokeApiKey(getKv(), userId, created.record.id);
      },
    };
  });
}
