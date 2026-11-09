/**
 * Fetch a public listing page with a normal browser-like User-Agent.
 * No login, captcha bypass, or hidden APIs — plain HTTP GET with timeout.
 */
import type { ListingFetchOutcome } from "@/domain/listing/types";

export const LISTING_FETCH_TIMEOUT_MS = 12_000;
export const LISTING_FETCH_MAX_BYTES = 1_500_000;

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BLOCK_SNIPPETS = [
  /captcha/i,
  /cf-browser-verification/i,
  /attention required/i,
  /access denied/i,
  /please verify you are a human/i,
  /enable javascript and cookies/i,
  /bot detection/i,
  /request blocked/i,
  /unusual traffic/i,
];

export type ListingFetchDeps = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: Date;
};

function isHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export function looksBlocked(status: number, html: string): boolean {
  if (status === 401 || status === 403 || status === 407 || status === 429) return true;
  if (status >= 500) return true;
  const head = html.slice(0, 8000);
  return BLOCK_SNIPPETS.some((pattern) => pattern.test(head));
}

export async function fetchListingPage(rawUrl: string, deps: ListingFetchDeps = {}): Promise<ListingFetchOutcome> {
  const fetchedAt = (deps.now ?? new Date()).toISOString();
  const parsed = isHttpUrl(rawUrl);
  if (!parsed) {
    return {
      ok: false,
      url: rawUrl,
      blocked: false,
      reason: "That does not look like an http(s) listing link.",
      status: null,
      fetchedAt,
    };
  }

  const fetchImpl = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? LISTING_FETCH_TIMEOUT_MS;
  try {
    const response = await fetchImpl(parsed.toString(), {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": BROWSER_UA,
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const status = response.status;
    const finalUrl = response.url || parsed.toString();
    const buffer = await response.arrayBuffer();
    const bytes = buffer.byteLength;
    if (bytes > LISTING_FETCH_MAX_BYTES) {
      return {
        ok: false,
        url: parsed.toString(),
        blocked: false,
        reason: "The listing page was too large to read safely.",
        status,
        fetchedAt,
      };
    }
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    if (!response.ok || looksBlocked(status, html)) {
      return {
        ok: false,
        url: parsed.toString(),
        blocked: true,
        reason:
          status === 403 || status === 401
            ? "The site blocked this request (login or anti-bot wall)."
            : status === 429
              ? "The site rate-limited this request."
              : status >= 500
                ? "The listing site returned a server error."
                : "The site returned a challenge page instead of the listing.",
        status,
        fetchedAt,
      };
    }
    if (!html || html.replace(/\s+/g, "").length < 40) {
      return {
        ok: false,
        url: parsed.toString(),
        blocked: true,
        reason: "The listing page came back empty or unreadable.",
        status,
        fetchedAt,
      };
    }
    return {
      ok: true,
      url: parsed.toString(),
      finalUrl,
      status,
      html,
      fetchedAt,
    };
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return {
      ok: false,
      url: parsed.toString(),
      blocked: true,
      reason: timedOut
        ? "The listing site did not respond in time."
        : "Could not reach the listing site.",
      status: null,
      fetchedAt,
    };
  }
}
