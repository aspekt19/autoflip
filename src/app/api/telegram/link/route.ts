import { getKv } from "@/io/kv";
import {
  mintTelegramLinkToken,
  telegramDeepLink,
  TELEGRAM_BOT_USERNAME_DEFAULT,
} from "@/io/telegram";
import { saveTelegramCode } from "@/server/radar-store";
import { requirePaidAccess } from "@/server/session";

export const dynamic = "force-dynamic";

export async function POST() {
  const access = await requirePaidAccess();
  if (!access.ok) return access.response;
  const id = access.id;
  const username =
    process.env.TELEGRAM_BOT_USERNAME?.trim()?.replace(/^@/, "") || TELEGRAM_BOT_USERNAME_DEFAULT;
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const signing =
    process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || process.env.AUTH_SECRET?.trim() || "";
  if (!token || !signing) {
    return Response.json({
      configured: false,
      message: "Telegram is not configured. Alerts stay in this app.",
    });
  }
  const signed = mintTelegramLinkToken(id, signing);
  // Also store a one-time KV code keyed by the signed token so /start is single-use.
  await saveTelegramCode(getKv(), signed, id);
  return Response.json({
    configured: true,
    url: telegramDeepLink(username, signed),
    botUsername: username,
  });
}
