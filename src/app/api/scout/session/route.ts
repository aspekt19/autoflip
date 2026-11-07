import { NextResponse } from "next/server";
import { getKv } from "@/io/kv";
import { resolveApiKeyRecord } from "@/server/api-keys";
import { findActiveGrantsForKey } from "@/server/scout/owner-grant";
import {
  clearScoutSignedSession,
  mintScoutSessionToken,
  writeScoutSignedSession,
} from "@/server/scout/signed-session";

export const runtime = "nodejs";

/**
 * POST /api/scout/session — exchange a grant-bound af_ key for an HMAC Scout session cookie.
 * Does not trust unsigned af_uid. Key must match an active owner grant's apiKeyHash.
 */
export async function POST(req: Request) {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() || null;
  if (!token?.startsWith("af_")) {
    return NextResponse.json(
      {
        error: "api_key_required",
        message: "Present Authorization: Bearer af_… that is bound to an owner grant.",
      },
      { status: 401 },
    );
  }

  const kv = getKv();
  const record = await resolveApiKeyRecord(kv, token);
  if (!record) {
    return NextResponse.json(
      { error: "invalid_key", message: "That API key is missing or revoked." },
      { status: 401 },
    );
  }

  const grants = await findActiveGrantsForKey(kv, record.userId, record.hash);
  if (!grants.length) {
    return NextResponse.json(
      {
        error: "grant_required",
        message:
          "No active owner grant is bound to this API key. Minting a key from an unsigned browser cookie does not create Scout privileges.",
      },
      { status: 403 },
    );
  }

  const grant = grants[0]!;
  const minted = mintScoutSessionToken({
    userId: record.userId,
    grantId: grant.id,
    keyHashPrefix: record.hash,
  });
  if (!minted.ok) {
    return NextResponse.json({ error: "session_secret_missing", message: minted.reason }, { status: 503 });
  }

  await writeScoutSignedSession(minted.token);
  return NextResponse.json({
    ok: true,
    userId: record.userId,
    grantId: grant.id,
    providers: Object.keys(grant.providers),
    provenance: grant.provenance,
    expiresAt: minted.session.exp,
  });
}

/** DELETE /api/scout/session — clear signed Scout cookie. */
export async function DELETE() {
  await clearScoutSignedSession();
  return NextResponse.json({ ok: true });
}
