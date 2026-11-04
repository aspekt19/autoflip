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

export const CONNECT_HELP =
  "AutoFlip Deal Radar can send new listing alerts to this chat. On the AutoFlip site, open Deal Radar and choose Connect Telegram. That link brings you back here with a code, and this chat is then tied to your alerts. Each alert has Analyze (a full report, 1 credit) and Skip. Watching a saved search does not use a credit.";

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

export function alertMessage(input: { why: string; origin: string; alertId: string }): {
  text: string;
  reply_markup: { inline_keyboard: TelegramButton[][] };
} {
  return {
    text: `${input.why}\n\nMonitoring did not use a credit. A full report is 1 credit.`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Analyze — 1 credit", url: `${input.origin}/radar?alert=${input.alertId}` },
          { text: "Skip", callback_data: `skip:${input.alertId}` },
        ],
      ],
    },
  };
}

export function parseSkipCallback(data: string): string | null {
  const match = data.match(/^skip:([A-Za-z0-9-]{8,80})$/);
  return match?.[1] ?? null;
}
