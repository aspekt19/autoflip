import { createHash } from "node:crypto";

export type FindReplayRequest = { method: string; url: string; headers: Array<[string, string]>; body: string };
export type FindReplayResponse =
  | { kind: "response"; status: number; statusText: string; headers: Array<[string, string]>; body: string }
  | { kind: "error"; message: string };
export type FindReplayCassetteEntry = { key: string; request: FindReplayRequest; response: FindReplayResponse };
export type FindReplayCassette = { schemaVersion: 1; entries: FindReplayCassetteEntry[] };
export type FindReplayEvent = { kind: "recorded" | "replayed" | "miss" | "transport_error"; key: string; method: string; url: string };

function requestKey(request: FindReplayRequest): string {
  return createHash("sha256").update(request.method).update("\n").update(request.url).update("\n").update(request.body).digest("hex");
}

function cassetteSafeUrl(raw: string): string {
  const url = new URL(raw);
  for (const key of [...url.searchParams.keys()]) {
    if (/(?:api.?key|access.?token|auth|secret|signature|credential|password)/i.test(key)) {
      url.searchParams.set(key, "[REDACTED]");
    }
  }
  return url.toString();
}

async function describeRequest(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init);
  const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.clone().text();
  const safeHeaders = [...request.headers.entries()]
    .filter(([name]) => ["accept", "content-type", "x-api-version"].includes(name.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  const descriptor = { method: request.method.toUpperCase(), url: cassetteSafeUrl(request.url), headers: safeHeaders, body };
  return { request, descriptor, key: requestKey(descriptor) };
}

function responseFromEntry(entry: FindReplayCassetteEntry): Response {
  if (entry.response.kind === "error") throw new Error(entry.response.message);
  const { status, statusText, headers, body } = entry.response;
  const noBody = status === 204 || status === 205 || status === 304;
  return new Response(noBody ? null : body, { status, statusText, headers });
}

/** Records upstream tool HTTP traffic; keep the normal fetch for live SERV calls. */
export function createFindRecordingFetch(fetchImpl: typeof fetch = fetch): {
  fetch: typeof fetch;
  cassette: () => FindReplayCassette;
  events: FindReplayEvent[];
} {
  const entries: FindReplayCassetteEntry[] = [];
  const events: FindReplayEvent[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    const { request, descriptor, key } = await describeRequest(input, init);
    try {
      const response = await fetchImpl(request);
      entries.push({
        key,
        request: descriptor,
        response: { kind: "response", status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body: await response.clone().text() },
      });
      events.push({ kind: "recorded", key, method: descriptor.method, url: descriptor.url });
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upstream fetch failed";
      entries.push({ key, request: descriptor, response: { kind: "error", message } });
      events.push({ kind: "transport_error", key, method: descriptor.method, url: descriptor.url });
      throw error;
    }
  };
  return { fetch: recordingFetch, cassette: () => ({ schemaVersion: 1, entries: [...entries] }), events };
}

/** Replays by exact method + URL + request body. There is no network fallback. */
export function createFindReplayFetch(cassette: FindReplayCassette): {
  fetch: typeof fetch;
  events: FindReplayEvent[];
  assertConsumed: () => void;
} {
  if (cassette.schemaVersion !== 1 || !Array.isArray(cassette.entries)) throw new Error("Unsupported Find replay cassette schema.");
  const queues = new Map<string, FindReplayCassetteEntry[]>();
  for (const entry of cassette.entries) {
    if (!entry || typeof entry.key !== "string" || !entry.request || !entry.response) throw new Error("Invalid Find replay cassette entry.");
    if (!Array.isArray(entry.request.headers) || entry.key !== requestKey(entry.request)) throw new Error("Find replay cassette request hash mismatch.");
    const queue = queues.get(entry.key) ?? [];
    queue.push(entry);
    queues.set(entry.key, queue);
  }
  const used = new Map<string, number>();
  const events: FindReplayEvent[] = [];
  const replayFetch: typeof fetch = async (input, init) => {
    const { descriptor, key } = await describeRequest(input, init);
    const queue = queues.get(key);
    const index = used.get(key) ?? 0;
    const entry = queue?.[index];
    if (!entry) {
      events.push({ kind: "miss", key, method: descriptor.method, url: descriptor.url });
      throw new Error(`Find replay cassette miss: ${descriptor.method} ${descriptor.url}`);
    }
    used.set(key, index + 1);
    events.push({ kind: "replayed", key, method: descriptor.method, url: descriptor.url });
    return responseFromEntry(entry);
  };
  return {
    fetch: replayFetch,
    events,
    assertConsumed: () => {
      const consumed = [...used.values()].reduce((sum, count) => sum + count, 0);
      const unused = cassette.entries.length - consumed;
      if (unused !== 0) throw new Error(`Find replay cassette has ${unused} unused response(s).`);
    },
  };
}
