import { getKv } from "@/io/kv";
import { telegramChat, telegramPaused } from "@/server/radar-store";

export async function sendLinkedTelegram(
  userId: string,
  text: string,
  button?: { text: string; url?: string },
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;
  const chat = await telegramChat(getKv(), userId);
  if (!chat) return;
  if (await telegramPaused(getKv(), userId)) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text,
      ...(button?.url ? { reply_markup: { inline_keyboard: [[button]] } } : {}),
    }),
  }).catch(() => undefined);
}
