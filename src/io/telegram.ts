import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function newLinkCode(): string {
  return randomBytes(9).toString("hex");
}

export function parseStartCommand(text: string): string | null {
  const match = text.trim().match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{8,64})$/);
  return match?.[1] ?? null;
}

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
