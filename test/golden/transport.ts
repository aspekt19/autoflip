/**
 * Record / replay transport for SERV (ServDeps.fetch) and Auto.dev (AutodevDeps.fetch).
 *
 * Recordings are real upstream responses keyed by a request hash. Auth headers and
 * secret values are never written. Replay of a hash that is not on disk fails.
 * An empty recording directory is "not recorded yet" — it does not invent a body.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalString } from "@/domain/hash";

export type GoldenMode = "replay" | "record" | "live";

const AUTH_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
]);

const SECRET_QUERY = new Set(["key", "api_key", "apikey", "token", "access_token", "secret"]);

export type StoredRecording = {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
  model: string | null;
  responseId: string | null;
  at: string;
};

export class GoldenTransportError extends Error {
  readonly code: "UNSEEN_REQUEST" | "RECORDINGS_PENDING" | "SPEND_CAP";
  readonly hash: string;
  readonly url: string;

  constructor(code: GoldenTransportError["code"], message: string, hash: string, url: string) {
    super(message);
    this.name = "GoldenTransportError";
    this.code = code;
    this.hash = hash;
    this.url = url;
  }
}

export type TransportAttempt = {
  hash: string;
  method: string;
  url: string;
  unseen: boolean;
  pending: boolean;
};

export type GoldenFetch = {
  fetch: typeof fetch;
  pending: boolean;
  corpusSize: number;
  attempts: TransportAttempt[];
};

export function recordingsRoot(): string {
  return path.join(process.cwd(), "test", "golden", "recordings");
}

/** Drop auth headers and secret query params. Does not log values. */
export function publicHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const src = new Headers(headers ?? {});
  src.forEach((value, key) => {
    if (AUTH_HEADERS.has(key.toLowerCase())) return;
    if (/bearer\s+/i.test(value)) return;
    out[key.toLowerCase()] = value;
  });
  return out;
}

export function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.username = "";
  url.password = "";
  const keys = [...url.searchParams.keys()];
  for (const key of keys) {
    if (SECRET_QUERY.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  const entries = [...url.searchParams.entries()].sort((a, b) => {
    if (a[0] === b[0]) return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    return a[0] < b[0] ? -1 : 1;
  });
  url.search = "";
  for (const [key, value] of entries) url.searchParams.append(key, value);
  return url.toString();
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (body == null) return null;
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed;
    }
  }
  if (body instanceof URLSearchParams) return body.toString();
  return "[unreadable-body]";
}

/** Remove any string that equals a known secret. Never echo the secret. */
export function redactSecrets(value: unknown, secrets: readonly string[]): unknown {
  const banned = secrets.map((s) => s.trim()).filter((s) => s.length >= 8);
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (banned.some((secret) => node.includes(secret))) return "[redacted]";
      if (/bearer\s+\S+/i.test(node)) return node.replace(/bearer\s+\S+/gi, "Bearer [redacted]");
      return node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        if (/authorization|api[_-]?key|secret|token|password/i.test(key)) {
          out[key] = "[redacted]";
          continue;
        }
        out[key] = walk(child);
      }
      return out;
    }
    return node;
  };
  return walk(value);
}

export function requestHash(method: string, url: string, body: unknown): string {
  const identity = {
    method: method.toUpperCase(),
    url: normalizeUrl(url),
    body: body ?? null,
  };
  return createHash("sha256").update(canonicalString(identity)).digest("hex");
}

function provenanceOf(body: unknown): { model: string | null; responseId: string | null } {
  if (!body || typeof body !== "object") return { model: null, responseId: null };
  const row = body as Record<string, unknown>;
  const model = typeof row.model === "string" && row.model.trim() ? row.model.trim() : null;
  const responseId = typeof row.id === "string" && row.id.trim() ? row.id.trim() : null;
  return { model, responseId };
}

function safeResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const type = headers.get("content-type");
  if (type) out["content-type"] = type;
  return out;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function caseDir(root: string, caseId: string): string {
  return path.join(root, caseId);
}

export async function corpusSize(root: string, caseId: string): Promise<number> {
  try {
    const names = await readdir(caseDir(root, caseId));
    return names.filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export async function createGoldenFetch(input: {
  mode: GoldenMode;
  caseId: string;
  root?: string;
  /** Real network fetch. Used only for record and live. */
  liveFetch?: typeof fetch;
  /** Values to strip if they appear in a stored body. Never logged. */
  secrets?: readonly string[];
  /** Hard stop on SERV chat/responses calls during record (owner spend cap). */
  spend?: { maxServCalls: number; count: { n: number } };
}): Promise<GoldenFetch> {
  const root = input.root ?? recordingsRoot();
  const live = input.liveFetch ?? fetch;
  const secrets = input.secrets ?? [];
  const size = input.mode === "replay" ? await corpusSize(root, input.caseId) : 0;
  const pending = input.mode === "replay" && size === 0;
  const attempts: TransportAttempt[] = [];

  const goldenFetch: typeof fetch = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const href = normalizeUrl(typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url);
    const body = redactSecrets(parseBody(init?.body ?? null), secrets);
    const hash = requestHash(method, href, body);
    const headers = publicHeaders(init?.headers);

    if (input.mode === "record" && input.spend && /\/chat\/completions|\/responses(?:\?|$)/.test(href)) {
      input.spend.count.n += 1;
      if (input.spend.count.n > input.spend.maxServCalls) {
        throw new GoldenTransportError(
          "SPEND_CAP",
          `Stopped recording: OpenServ call cap (${input.spend.maxServCalls}) reached.`,
          hash,
          href,
        );
      }
    }

    if (input.mode === "replay") {
      const file = path.join(caseDir(root, input.caseId), `${hash}.json`);
      if (pending) {
        attempts.push({ hash, method, url: href, unseen: false, pending: true });
        throw new GoldenTransportError(
          "RECORDINGS_PENDING",
          `No recordings for ${input.caseId} yet (${hash.slice(0, 12)}).`,
          hash,
          href,
        );
      }
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        attempts.push({ hash, method, url: href, unseen: true, pending: false });
        throw new GoldenTransportError(
          "UNSEEN_REQUEST",
          `Replay has no recording for ${input.caseId} request ${hash}.`,
          hash,
          href,
        );
      }
      const stored = JSON.parse(raw) as StoredRecording;
      attempts.push({ hash, method, url: href, unseen: false, pending: false });
      const payload =
        typeof stored.response.body === "string" ? stored.response.body : JSON.stringify(stored.response.body ?? null);
      return new Response(payload, {
        status: stored.response.status,
        headers: stored.response.headers,
      });
    }

    const response = await live(href, { ...init, method });
    attempts.push({ hash, method, url: href, unseen: false, pending: false });
    if (input.mode === "live") return response;

    const clone = response.clone();
    const responseBody = redactSecrets(await readJsonBody(clone), secrets);
    const prov = provenanceOf(responseBody);
    const stored: StoredRecording = {
      request: { method, url: href, headers, body },
      response: {
        status: response.status,
        headers: safeResponseHeaders(response.headers),
        body: responseBody,
      },
      model: prov.model,
      responseId: prov.responseId,
      at: new Date().toISOString(),
    };
    const dir = caseDir(root, input.caseId);
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, `${hash}.json`);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await rename(tmp, target);
    return response;
  };

  return { fetch: goldenFetch, pending, corpusSize: size, attempts };
}

/** Listing-search URLs only (Auto.dev /listings), for limit checks. */
export function listingSearchUrls(attempts: readonly TransportAttempt[]): string[] {
  return attempts
    .map((row) => row.url)
    .filter((url) => {
      try {
        const parsed = new URL(url);
        return /\/listings\/?$/.test(parsed.pathname);
      } catch {
        return false;
      }
    });
}
