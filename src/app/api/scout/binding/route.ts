import { NextResponse } from "next/server";
import { getKv } from "@/io/kv";
import {
  bindingFromStored,
  listApiKeyBindings,
  resolveApiKeyRecord,
  type ApiKeyBinding,
} from "@/server/api-keys";
import { userId as browserUserId } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/scout/binding — non-secret Scout grant binding cards.
 *
 * Auth (either):
 * - Authorization: Bearer af_… → binding for that live key (no grant required)
 * - Signed browser cookie → all bindings for this browser account
 *
 * Never returns the af_ token. Hash ≠ secret; still share only with the intended operator.
 */
export async function GET(req: Request) {
  const kv = getKv();
  const auth = req.headers.get("authorization")?.trim() ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (!token.startsWith("af_")) {
      return NextResponse.json(
        { error: "invalid_key", message: "Bearer token must be an af_ agent key." },
        { status: 401 },
      );
    }
    const record = await resolveApiKeyRecord(kv, token);
    if (!record) {
      return NextResponse.json(
        { error: "key_inactive", message: "Key is missing or revoked." },
        { status: 401 },
      );
    }
    // Reload index row for label/prefix when present; fall back to hash-only card.
    const bindings = await listApiKeyBindings(kv, record.userId);
    const match = bindings.find((b) => b.apiKeyHash === record.hash && !b.revokedAt);
    const binding: ApiKeyBinding =
      match ??
      bindingFromStored({
        userId: record.userId,
        hash: record.hash,
        id: record.id,
        prefix: token.slice(0, 11),
        label: "Agent key",
        createdAt: new Date(0).toISOString(),
        revokedAt: null,
      });
    return NextResponse.json({
      binding,
      note: "Share userId + apiKeyHash with your operator for a Scout grant. Never paste the af_ token into chat.",
    });
  }

  const id = await browserUserId();
  const bindings = (await listApiKeyBindings(kv, id)).filter((b) => !b.revokedAt);
  return NextResponse.json({
    userId: id,
    bindings,
    note: "Share a binding card (userId + apiKeyHash) with your operator. Never share the af_ token.",
  });
}
