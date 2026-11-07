import { getKv } from "@/io/kv";
import { createApiKey, listApiKeyBindings, listApiKeys, revokeApiKey } from "@/server/api-keys";
import { userId } from "@/server/session";

export const dynamic = "force-dynamic";

const ACTIVE_LIMIT = 5;

export async function GET() {
  const id = await userId();
  const kv = getKv();
  const keys = await listApiKeys(kv, id);
  const bindings = await listApiKeyBindings(kv, id);
  return Response.json({
    userId: id,
    keys: keys.map(publicKey),
    /**
     * Non-secret Scout/operator binding cards (userId + apiKeyHash).
     * Never includes the af_ token. Share only with the intended operator.
     */
    bindings,
  });
}

export async function POST(request: Request) {
  const id = await userId();
  const body = (await request.json().catch(() => null)) as { label?: unknown } | null;
  const label = typeof body?.label === "string" ? body.label : "Agent key";
  const existing = await listApiKeys(getKv(), id);
  if (existing.filter((key) => !key.revokedAt).length >= ACTIVE_LIMIT) {
    return Response.json(
      { error: "too_many_keys", message: "Revoke an old key before creating another. Five live keys is the limit." },
      { status: 400 },
    );
  }
  const created = await createApiKey(getKv(), id, label);
  return Response.json({
    token: created.token,
    key: publicKey(created.record),
    binding: created.binding,
    note: "Copy the af_ token once for yourself. The binding card (userId + apiKeyHash) is what an operator needs for a Scout grant — never paste the af_ token into chat.",
  });
}

export async function DELETE(request: Request) {
  const id = await userId();
  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  const keyId = typeof body?.id === "string" ? body.id : "";
  const ok = await revokeApiKey(getKv(), id, keyId);
  if (!ok) return Response.json({ error: "not_found", message: "That key is already revoked or not on this account." }, { status: 404 });
  return Response.json({ ok: true });
}

function publicKey(record: { id: string; label: string; prefix: string; createdAt: string; revokedAt: string | null }) {
  return record;
}
