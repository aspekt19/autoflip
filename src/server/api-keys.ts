import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Kv } from "@/io/kv";
import { creditSpend } from "@/io/credit-book";

export type ApiKeyRecord = {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
};

type StoredKey = ApiKeyRecord & { userId: string; hash: string };

export function hashApiKeyToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashToken(token: string): string {
  return hashApiKeyToken(token);
}

/** Resolve full stored key row (hash + userId) for grant binding checks. */
export async function resolveApiKeyRecord(
  kv: Kv,
  token: string,
): Promise<{ userId: string; hash: string; id: string } | null> {
  if (!token.startsWith("af_")) return null;
  const raw = await kv.get(tokenKey(hashToken(token)));
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredKey;
    if (!stored.userId || stored.revokedAt || !stored.hash) return null;
    return { userId: stored.userId, hash: stored.hash, id: stored.id };
  } catch {
    return null;
  }
}

function tokenKey(hash: string): string {
  return `apikey:${hash}`;
}

function indexKey(userId: string): string {
  return `apikeys:${userId}`;
}

function publicRecord(stored: StoredKey): ApiKeyRecord {
  return {
    id: stored.id,
    label: stored.label,
    prefix: stored.prefix,
    createdAt: stored.createdAt,
    revokedAt: stored.revokedAt,
  };
}

async function readIndex(kv: Kv, userId: string): Promise<StoredKey[]> {
  const raw = await kv.get(indexKey(userId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as StoredKey[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function createApiKey(kv: Kv, userId: string, label: string): Promise<{ token: string; record: ApiKeyRecord }> {
  const token = `af_${randomBytes(24).toString("base64url")}`;
  const stored: StoredKey = {
    id: randomUUID(),
    label: (label.trim() || "Agent key").slice(0, 40),
    prefix: token.slice(0, 11),
    createdAt: new Date().toISOString(),
    revokedAt: null,
    userId,
    hash: hashToken(token),
  };
  await kv.set(tokenKey(stored.hash), JSON.stringify(stored));
  const list = await readIndex(kv, userId);
  list.push(stored);
  await kv.set(indexKey(userId), JSON.stringify(list));
  return { token, record: publicRecord(stored) };
}

export async function listApiKeys(kv: Kv, userId: string): Promise<ApiKeyRecord[]> {
  return (await readIndex(kv, userId)).map(publicRecord);
}

export async function revokeApiKey(kv: Kv, userId: string, id: string): Promise<boolean> {
  const list = await readIndex(kv, userId);
  const item = list.find((key) => key.id === id && key.userId === userId);
  if (!item || item.revokedAt) return false;
  item.revokedAt = new Date().toISOString();
  await kv.set(tokenKey(item.hash), JSON.stringify(item));
  await kv.set(indexKey(userId), JSON.stringify(list));
  return true;
}

/** A live key returns its account. A missing or revoked key returns null. */
export async function resolveApiKey(kv: Kv, token: string): Promise<string | null> {
  if (!token.startsWith("af_")) return null;
  const raw = await kv.get(tokenKey(hashToken(token)));
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredKey;
    if (!stored.userId || stored.revokedAt) return null;
    return stored.userId;
  } catch {
    return null;
  }
}

export async function spendReportCredit(
  kv: Kv,
  userId: string,
  idempotencyKey: string,
): Promise<{ ok: true; balance: number } | { ok: false; balance: number }> {
  return creditSpend(kv, userId, idempotencyKey);
}
