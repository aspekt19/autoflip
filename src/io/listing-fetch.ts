/**
 * Fetch a public listing page with a normal browser-like User-Agent.
 * No login, captcha bypass, or hidden APIs — plain HTTP GET with timeout.
 * Private, loopback, and metadata addresses are refused, including after redirects.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { ListingFetchOutcome } from "@/domain/listing/types";

export const LISTING_FETCH_TIMEOUT_MS = 12_000;
export const LISTING_FETCH_MAX_BYTES = 1_500_000;
export const LISTING_FETCH_MAX_REDIRECTS = 5;

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

const PRIVATE_REASON = "That link is not a public web page we can fetch.";

const blockedNets = new BlockList();
blockedNets.addSubnet("0.0.0.0", 8, "ipv4");
blockedNets.addSubnet("10.0.0.0", 8, "ipv4");
blockedNets.addSubnet("127.0.0.0", 8, "ipv4");
blockedNets.addSubnet("169.254.0.0", 16, "ipv4");
blockedNets.addSubnet("172.16.0.0", 12, "ipv4");
blockedNets.addSubnet("192.0.0.0", 24, "ipv4");
blockedNets.addSubnet("192.0.2.0", 24, "ipv4");
blockedNets.addSubnet("192.168.0.0", 16, "ipv4");
blockedNets.addSubnet("198.18.0.0", 15, "ipv4");
blockedNets.addSubnet("198.51.100.0", 24, "ipv4");
blockedNets.addSubnet("203.0.113.0", 24, "ipv4");
blockedNets.addSubnet("224.0.0.0", 4, "ipv4");
blockedNets.addSubnet("240.0.0.0", 4, "ipv4");
blockedNets.addAddress("255.255.255.255", "ipv4");
blockedNets.addSubnet("100.64.0.0", 10, "ipv4");
blockedNets.addAddress("::", "ipv6");
blockedNets.addAddress("::1", "ipv6");
blockedNets.addSubnet("fc00::", 7, "ipv6");
blockedNets.addSubnet("fe80::", 10, "ipv6");
blockedNets.addSubnet("ff00::", 8, "ipv6");

export type ListingFetchDeps = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: Date;
  /** Test hook. Defaults to DNS. Return every address the name resolves to. */
  lookup?: (hostname: string) => Promise<string[]>;
};

function isHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (!url.hostname) return null;
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

/** True for loopback, private, link-local, multicast, and cloud metadata addresses. */
export function isBlockedIpAddress(address: string): boolean {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const ip = mapped?.[1] ?? address;
  const family = isIP(ip);
  if (family === 4) return blockedNets.check(ip, "ipv4");
  if (family === 6) return blockedNets.check(ip, "ipv6");
  return true;
}

function dottedIpv4(hostname: string): string | "ambiguous" | null {
  if (!/^\d+(?:\.\d+){3}$/.test(hostname)) return null;
  const parts = hostname.split(".");
  if (parts.some((part) => part.length > 3 || (part.length > 1 && part.startsWith("0")))) return "ambiguous";
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => n > 255)) return "ambiguous";
  return nums.join(".");
}

function integerIpv4(hostname: string): string | null {
  if (!/^\d+$/.test(hostname)) return null;
  const value = Number(hostname);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return null;
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function blockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localdomain")) return true;
  if (host === "metadata.google.internal" || host === "metadata" || host.endsWith(".metadata.google.internal")) return true;
  if (host === "host.docker.internal" || host === "kubernetes.default" || host.endsWith(".svc")) return true;
  return false;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/** Refuse the URL before any bytes are requested. */
export async function publicFetchDenial(
  url: URL,
  lookup: (hostname: string) => Promise<string[]> = defaultLookup,
): Promise<string | null> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (blockedHostname(hostname)) return PRIVATE_REASON;
  if (/^0x[0-9a-f]+$/i.test(hostname)) return PRIVATE_REASON;
  const dotted = dottedIpv4(hostname);
  if (dotted === "ambiguous") return PRIVATE_REASON;
  const literal = dotted ?? integerIpv4(hostname) ?? (isIP(hostname) ? hostname : null);
  if (literal) return isBlockedIpAddress(literal) ? PRIVATE_REASON : null;
  let addresses: string[];
  try {
    addresses = await lookup(hostname);
  } catch {
    return "Could not resolve the listing site.";
  }
  if (addresses.length === 0 || addresses.some((address) => isBlockedIpAddress(address))) return PRIVATE_REASON;
  return null;
}

async function readLimited(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return text.length > maxBytes ? null : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
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
  const lookup = deps.lookup ?? defaultLookup;
  const timeoutMs = deps.timeoutMs ?? LISTING_FETCH_TIMEOUT_MS;
  let current = parsed;
  const seen = new Set<string>();

  try {
    for (let hop = 0; hop <= LISTING_FETCH_MAX_REDIRECTS; hop += 1) {
      const key = current.toString();
      if (seen.has(key)) {
        return {
          ok: false,
          url: parsed.toString(),
          blocked: true,
          reason: "The listing link redirected in a loop.",
          status: null,
          fetchedAt,
        };
      }
      seen.add(key);
      const denial = await publicFetchDenial(current, lookup);
      if (denial) {
        return {
          ok: false,
          url: parsed.toString(),
          blocked: true,
          reason: denial,
          status: null,
          fetchedAt,
        };
      }

      const response = await fetchImpl(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": BROWSER_UA,
          "Cache-Control": "no-cache",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location || hop === LISTING_FETCH_MAX_REDIRECTS) {
          return {
            ok: false,
            url: parsed.toString(),
            blocked: true,
            reason: "The listing link redirected too many times.",
            status: response.status,
            fetchedAt,
          };
        }
        current = new URL(location, current);
        if (current.protocol !== "http:" && current.protocol !== "https:") {
          return {
            ok: false,
            url: parsed.toString(),
            blocked: true,
            reason: PRIVATE_REASON,
            status: response.status,
            fetchedAt,
          };
        }
        continue;
      }

      const status = response.status;
      const finalUrl = current.toString();
      const html = await readLimited(response, LISTING_FETCH_MAX_BYTES);
      if (html == null) {
        return {
          ok: false,
          url: parsed.toString(),
          blocked: false,
          reason: "The listing page was too large to read safely.",
          status,
          fetchedAt,
        };
      }
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
    }
    return {
      ok: false,
      url: parsed.toString(),
      blocked: true,
      reason: "The listing link redirected too many times.",
      status: null,
      fetchedAt,
    };
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return {
      ok: false,
      url: parsed.toString(),
      blocked: true,
      reason: timedOut ? "The listing site did not respond in time." : "Could not reach the listing site.",
      status: null,
      fetchedAt,
    };
  }
}
