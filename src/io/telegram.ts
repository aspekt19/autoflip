import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { buyerDistanceText } from "@/domain/geo";
import { renderStructuredOffer } from "@/domain/structured-offer";

export const LINK_TTL_MS = 15 * 60 * 1000;

/** Bot public handle — display name in BotFather is "Lemonless Radar". */
export const TELEGRAM_BOT_USERNAME_DEFAULT = "autoflip_radar_bot";

export function newLinkCode(): string {
  return randomBytes(12).toString("base64url");
}

/**
 * One-time signed start token: base64url(userId.exp).hmac
 * Verified with TELEGRAM_WEBHOOK_SECRET (or AUTH_SECRET fallback).
 */
export function mintTelegramLinkToken(
  userId: string,
  secret: string,
  now = Date.now(),
): string {
  const exp = now + LINK_TTL_MS;
  const payload = Buffer.from(`${userId}.${exp}`, "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 22);
  return `${payload}.${sig}`;
}

export function verifyTelegramLinkToken(
  token: string,
  secret: string,
  now = Date.now(),
): { ok: true; userId: string } | { ok: false; reason: "invalid" | "expired" } {
  const parts = token.trim().split(".");
  if (parts.length !== 2) return { ok: false, reason: "invalid" };
  const [payload, sig] = parts;
  if (!payload || !sig) return { ok: false, reason: "invalid" };
  const expected = createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 22);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "invalid" };
  } catch {
    return { ok: false, reason: "invalid" };
  }
  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const dot = decoded.lastIndexOf(".");
  if (dot < 1) return { ok: false, reason: "invalid" };
  const userId = decoded.slice(0, dot);
  const exp = Number(decoded.slice(dot + 1));
  if (!userId || !Number.isFinite(exp)) return { ok: false, reason: "invalid" };
  if (now > exp) return { ok: false, reason: "expired" };
  return { ok: true, userId };
}

export function parseStartCommand(text: string): string | null {
  const match = text.trim().match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{8,200})$/);
  return match?.[1] ?? null;
}

export function isBareStart(text: string): boolean {
  return /^\/start(?:@\w+)?\s*$/i.test(text.trim());
}

export function isHelpCommand(text: string): boolean {
  return /^\/help(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

export function isStopCommand(text: string): boolean {
  return /^\/stop(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

export const CONNECT_HELP =
  "Lemonless Radar can send Deal Radar alerts to this chat. On the site, open Deal Radar and choose Connect Telegram. That link lasts 15 minutes and works once. Send /stop to unlink this chat. In-app alerts stay on the Deal Radar page.";

export const CODE_EXPIRED =
  "That connect link expired. Open Deal Radar and choose Connect Telegram for a new one. Links last 15 minutes.";

export const CODE_USED =
  "That connect link was already used or is not valid. Open Deal Radar and choose Connect Telegram for a new one.";

export const LINKED_TEXT =
  "This chat is connected to Lemonless Radar. Deal Radar alerts will arrive here. Send /stop to unlink. Viewing alerts in Lemonless does not use a credit.";

export const STOPPED_TEXT =
  "This chat is unlinked. Deal Radar alerts stay in Lemonless. Open Deal Radar and choose Connect Telegram to link again.";

export const NOT_LINKED_TEXT =
  "This chat is not connected yet. Open Deal Radar and choose Connect Telegram. The link lasts 15 minutes.";

export function telegramDeepLink(username: string, token: string): string {
  const handle = username.replace(/^@/, "");
  return `https://t.me/${handle}?start=${token}`;
}

export function webhookAuthorized(header: string | null, expected: string): boolean {
  if (!expected || header === null) return false;
  try {
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** https listing URLs only — never invent; pass through from the per-VIN record. */
export function httpsListingUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^https:\/\//i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export type RadarTelegramAlertCopy = {
  year: number;
  make: string;
  model: string;
  priceUsd: number;
  miles: number | null;
  distanceMiles: number | null;
  radiusCheck?: "unverified" | "known" | null;
  listingUrl: string | null;
  reportUrl: string;
  searchName?: string | null;
  openingOffer?: number | null;
  walkAway?: number | null;
};

function money(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function offerLine(input: RadarTelegramAlertCopy): string | null {
  if (input.openingOffer === undefined && input.walkAway === undefined) return null;
  return renderStructuredOffer({
    openingOffer: input.openingOffer ?? null,
    walkAway: input.walkAway ?? null,
  });
}

/** Telegram body for a Deal Radar alert — must include listing https URL when known. */
export function radarAlertTelegramText(input: RadarTelegramAlertCopy): string {
  const lines = [
    input.searchName ? `Deal Radar · ${input.searchName}` : "Deal Radar match",
    "",
    `${input.year} ${input.make} ${input.model}`,
    money(input.priceUsd),
    input.miles === null ? "Mileage not listed" : `${input.miles.toLocaleString("en-US")} mi`,
    buyerDistanceText({ distanceMiles: input.distanceMiles, radiusCheck: input.radiusCheck }),
    ...(offerLine(input) ? [offerLine(input)!] : []),
    "",
  ];
  const listing = httpsListingUrl(input.listingUrl);
  if (listing) {
    lines.push(`Dealer listing: ${listing}`);
  } else {
    lines.push("Dealer listing: not available from this record");
  }
  lines.push(`Lemonless report: ${input.reportUrl}`);
  lines.push("");
  lines.push("In-app alerts stay on Deal Radar. This message is a copy.");
  return lines.join("\n");
}

export function radarAlertKeyboard(reportUrl: string, listingUrl: string | null): {
  inline_keyboard: Array<Array<{ text: string; url: string }>>;
} {
  const row: Array<{ text: string; url: string }> = [{ text: "Open in Lemonless", url: reportUrl }];
  const listing = httpsListingUrl(listingUrl);
  if (listing) row.push({ text: "Dealer listing", url: listing });
  return { inline_keyboard: [row] };
}
