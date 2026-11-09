import { randomBytes } from "node:crypto";
import { productFlagsUnavailableMessage, resolveProductFlags } from "@/domain/product-flags";
import { getKv } from "@/io/kv";
import { telegramDeepLink } from "@/io/telegram";
import { saveTelegramCode } from "@/server/radar-store";
import { ledgerOwnerId } from "@/server/session";

export const dynamic = "force-dynamic";

export async function POST() {
  const flags = resolveProductFlags();
  if (!flags.telegram) {
    return Response.json({
      configured: false,
      message: productFlagsUnavailableMessage("telegram"),
    });
  }
  const id = await ledgerOwnerId();
  const username = process.env.TELEGRAM_BOT_USERNAME?.trim();
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!username || !token) {
    return Response.json({
      configured: false,
      message: "Telegram is not configured. Alerts stay in this app.",
    });
  }
  const code = randomBytes(9).toString("hex");
  await saveTelegramCode(getKv(), code, id);
  return Response.json({ configured: true, url: telegramDeepLink(username, code) });
}
