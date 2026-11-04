import { getKv } from "@/io/kv";
import { parseSkipCallback, parseStartCommand, webhookAuthorized } from "@/io/telegram";
import { listAlerts, saveAlerts, bindTelegram } from "@/server/radar-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
  if (!webhookAuthorized(request.headers.get("x-telegram-bot-api-secret-token"), expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const update = (await request.json().catch(() => null)) as {
    message?: { text?: string; chat?: { id?: number } };
    callback_query?: { data?: string; id?: string };
  } | null;
  const kv = getKv();
  const text = update?.message?.text ?? "";
  const code = text ? parseStartCommand(text) : null;
  const chatId = update?.message?.chat?.id;
  if (code && chatId !== undefined) {
    const bound = await bindTelegram(kv, code, String(chatId));
    if (bound.ok && process.env.TELEGRAM_BOT_TOKEN) {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: "AutoFlip alerts will arrive in this chat. A full report still costs 1 credit." }),
      }).catch(() => undefined);
    }
  }
  const skipId = update?.callback_query?.data ? parseSkipCallback(update.callback_query.data) : null;
  if (skipId) {
    const alerts = await listAlerts(kv);
    for (const alert of alerts) {
      if (alert.id === skipId) alert.status = "skipped";
    }
    await saveAlerts(kv, alerts);
    if (process.env.TELEGRAM_BOT_TOKEN && update?.callback_query?.id) {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: update.callback_query.id, text: "Skipped" }),
      }).catch(() => undefined);
    }
  }
  return Response.json({ ok: true });
}
