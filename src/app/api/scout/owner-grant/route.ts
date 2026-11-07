import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getKv, isDistributedQuotaBackend } from "@/io/kv";
import {
  saveOwnerGrant,
  type ScoutOwnerGrant,
  type ScoutProviderBudget,
} from "@/server/scout/owner-grant";

export const runtime = "nodejs";

/**
 * POST /api/scout/owner-grant — operator-only grant creation.
 * Requires header X-Scout-Grant-Admin: SCOUT_OWNER_GRANT_ADMIN_TOKEN.
 * Never accepts env balance strings as authority.
 */
export async function POST(req: Request) {
  const expected = process.env.SCOUT_OWNER_GRANT_ADMIN_TOKEN?.trim();
  if (!expected || expected.length < 16) {
    return NextResponse.json(
      {
        error: "admin_token_unconfigured",
        message: "SCOUT_OWNER_GRANT_ADMIN_TOKEN must be set (≥16 chars) on the server.",
      },
      { status: 503 },
    );
  }
  const provided = req.headers.get("x-scout-grant-admin")?.trim() || "";
  if (provided !== expected) {
    return NextResponse.json({ error: "unauthorized", message: "Invalid grant admin token." }, { status: 401 });
  }

  const kv = getKv();
  if (!isDistributedQuotaBackend(kv)) {
    return NextResponse.json(
      { error: "upstash_required", message: "Owner grants require Upstash Kv." },
      { status: 503 },
    );
  }

  let body: {
    ownerUserId?: string;
    apiKeyHash?: string;
    provenance?: string;
    expiresAt?: string | null;
    providers?: {
      serv?: Partial<ScoutProviderBudget>;
      autodev?: Partial<ScoutProviderBudget>;
    };
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.ownerUserId?.trim() || !body.apiKeyHash?.trim()) {
    return NextResponse.json(
      {
        error: "invalid_grant",
        message: "ownerUserId and apiKeyHash (SHA-256 of af_ token) are required.",
      },
      { status: 400 },
    );
  }

  const providers: ScoutOwnerGrant["providers"] = {};
  for (const name of ["serv", "autodev"] as const) {
    const raw = body.providers?.[name];
    if (!raw) continue;
    providers[name] = {
      maxCalls: Number(raw.maxCalls),
      maxSpendUsd:
        raw.maxSpendUsd == null || raw.maxSpendUsd === undefined ? null : Number(raw.maxSpendUsd),
      note: typeof raw.note === "string" ? raw.note : `explicit ${name} grant`,
    };
  }

  const grant: ScoutOwnerGrant = {
    version: 1,
    id: randomUUID(),
    ownerUserId: body.ownerUserId.trim(),
    apiKeyHash: body.apiKeyHash.trim().toLowerCase(),
    providers,
    expiresAt: body.expiresAt ?? null,
    provenance:
      typeof body.provenance === "string" && body.provenance.trim()
        ? body.provenance.trim()
        : "admin_token:SCOUT_OWNER_GRANT_ADMIN_TOKEN — call-count-only grant (maxSpendUsd unsupported)",
    createdAt: new Date().toISOString(),
  };

  const saved = await saveOwnerGrant(kv, grant);
  if (!saved.ok) {
    return NextResponse.json({ error: "grant_rejected", message: saved.message }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    grant: {
      id: grant.id,
      ownerUserId: grant.ownerUserId,
      apiKeyHashPrefix: grant.apiKeyHash.slice(0, 12),
      providers: grant.providers,
      expiresAt: grant.expiresAt,
      provenance: grant.provenance,
    },
  });
}
