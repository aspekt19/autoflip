import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function newLinkCode(): string {
  return randomBytes(9).toString("hex");
}

export function parseStartCommand(text: string): string | null {
  const match = text.trim().match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{8,64})$/);
  return match?.[1] ?? null;
}

export function isBareStart(text: string): boolean {
  return /^\/start(?:@\w+)?\s*$/i.test(text.trim());
}

export function isHelpCommand(text: string): boolean {
  return /^\/help(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

export function isSearchesCommand(text: string): boolean {
  return /^\/searches(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

export function isPauseCommand(text: string): boolean {
  return /^\/pause(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

export function isResumeCommand(text: string): boolean {
  return /^\/resume(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

export function parsePauseCallback(data: string): "pause" | "resume" | null {
  if (data === "pause" || data === "resume") return data;
  return null;
}

export const CONNECT_HELP =
  "Lemonless can send Deal Radar alerts to this chat. On the site, open Deal Radar and choose Connect Telegram. That link lasts 15 minutes and works once. Commands: /searches, /pause, /resume, and /help. View in Lemonless does not use a credit. Full analysis is 1 credit, and only after you confirm on the site. Not for me hides that listing only. Watching a saved search does not use a credit.";

export const CODE_EXPIRED =
  "That connect link expired. Open Deal Radar and choose Connect Telegram for a new one. Links last 15 minutes.";

export const CODE_USED =
  "That connect link was already used or is not valid. Open Deal Radar and choose Connect Telegram for a new one.";

export const LINKED_TEXT =
  "This chat is connected. Alerts for your saved searches will arrive here. View in Lemonless does not use a credit. Full analysis is 1 credit, and only after you confirm on the site.";

export const PAUSED_TEXT =
  "Telegram alerts are paused. Your saved searches are unchanged, and new matches still show in Lemonless. Send /resume when you want Telegram alerts again.";

export const RESUMED_TEXT = "Telegram alerts are on again. Send /pause to stop them without deleting your searches.";

export const SEARCHES_TEXT = "Your saved searches are on the Deal Radar page.";

export const NOT_LINKED_TEXT =
  "This chat is not connected yet. Open Deal Radar and choose Connect Telegram. The link lasts 15 minutes.";

export const REPORT_FAILED_TEXT = "The report did not finish. No credit was used.";

export const LINK_TTL_MS = 15 * 60 * 1000;

export function telegramDeepLink(username: string, code: string): string {
  const handle = username.replace(/^@/, "");
  return `https://t.me/${handle}?start=${code}`;
}

export function webhookAuthorized(header: string | null, expected: string): boolean {
  if (!expected || header === null) return false;
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export type TelegramButton = { text: string; url?: string; callback_data?: string };

export type AlertCopy = {
  searchName: string;
  mode: "personal" | "flip";
  year: number;
  make: string;
  model: string;
  priceUsd: number;
  miles: number | null;
  city: string | null;
  state: string | null;
  priceDropFrom: number | null;
  budgetUsd: number | null;
  radiusMiles: number | null;
  zip: string | null;
  yearMin: number | null;
  yearMax: number | null;
  milesMax: number | null;
  bodyStyle: string | null;
  /** Shared price label. Null when this alert has no price evaluation. */
  priceLabel?: "Good price" | "Fair price" | "High price" | "Not enough similar cars" | null;
  /** Same fair value as the card, report, and offer. */
  fairValueUsd?: number | null;
  origin: string;
  alertId: string;
};

function money(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function alertText(input: AlertCopy): string {
  const place = [input.city, input.state].filter(Boolean).join(", ");
  const lines = [
    `Saved search: ${input.searchName}`,
    "",
    `${input.year} ${input.make} ${input.model}`,
    money(input.priceUsd),
    input.miles === null ? "Mileage not listed" : `${input.miles.toLocaleString("en-US")} mi`,
    place || "Location not listed",
    "",
    input.mode === "flip" ? "Worth a look" : "Why it matched",
  ];
  const bullets: string[] = [];
  if (input.budgetUsd !== null && input.priceUsd <= input.budgetUsd) {
    bullets.push(`Asking price is within the ${money(input.budgetUsd)} budget`);
  }
  if (input.radiusMiles !== null && input.zip) bullets.push(`Within ${input.radiusMiles} miles of ${input.zip}`);
  if (input.yearMin !== null && input.yearMax !== null) bullets.push(`Year is inside ${input.yearMin}–${input.yearMax}`);
  if (input.milesMax !== null && input.miles !== null && input.miles <= input.milesMax) {
    bullets.push(`Mileage is within the ${input.milesMax.toLocaleString("en-US")} mi limit`);
  }
  if (input.bodyStyle) bullets.push(`Body type matches ${input.bodyStyle}`);
  if (input.priceDropFrom !== null) bullets.push(`Price dropped from ${money(input.priceDropFrom)}`);
  if (input.priceLabel) {
    const fair = input.fairValueUsd != null ? ` Fair value ${money(input.fairValueUsd)}.` : "";
    bullets.push(`Price: ${input.priceLabel}.${fair}`);
  }
  for (const bullet of bullets) lines.push(`• ${bullet}`);
  lines.push("");
  lines.push("This is a preliminary match. History and condition are not checked yet.");
  if (input.mode === "flip") {
    lines.push("Fees, repairs, and history still need checking before a full analysis.");
  }
  lines.push("");
  lines.push("Viewing this alert does not use a credit. A full analysis is 1 credit, and only after you confirm on the site.");
  return lines.join("\n");
}

export function alertKeyboard(origin: string, alertId: string): { inline_keyboard: TelegramButton[][] } {
  const root = origin.replace(/\/$/, "");
  return {
    inline_keyboard: [
      [{ text: "View in Lemonless", url: `${root}/radar#alert-${alertId}` }],
      [
        { text: "Full analysis — 1 credit", url: `${root}/radar?confirm=${alertId}` },
        { text: "Not for me", callback_data: `skip:${alertId}` },
      ],
      [
        { text: "My searches", url: `${root}/radar` },
        { text: "Pause alerts", callback_data: "pause" },
      ],
    ],
  };
}

export function alertMessage(input: AlertCopy): {
  text: string;
  reply_markup: { inline_keyboard: TelegramButton[][] };
} {
  return { text: alertText(input), reply_markup: alertKeyboard(input.origin, input.alertId) };
}

export function helpKeyboard(origin: string, paused: boolean): { inline_keyboard: TelegramButton[][] } {
  const root = origin.replace(/\/$/, "");
  return {
    inline_keyboard: [
      [{ text: "My searches", url: `${root}/radar` }],
      [{ text: paused ? "Resume alerts" : "Pause alerts", callback_data: paused ? "resume" : "pause" }],
    ],
  };
}

export function reportReadyMessage(input: { car: string; recommendation: string; origin: string; reportId: string }): {
  text: string;
  reply_markup: { inline_keyboard: TelegramButton[][] };
} {
  const root = input.origin.replace(/\/$/, "");
  return {
    text: `✅ Report ready — ${input.car}\n${input.recommendation}\nUsed 1 credit.`,
    reply_markup: { inline_keyboard: [[{ text: "Open full report", url: `${root}/report/${input.reportId}` }]] },
  };
}

export function parseSkipCallback(data: string): string | null {
  const match = data.match(/^skip:([A-Za-z0-9-]{8,80})$/);
  return match?.[1] ?? null;
}
