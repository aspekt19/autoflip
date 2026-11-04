import { getKv } from "@/io/kv";
import {
  CODE_EXPIRED,
  CODE_USED,
  CONNECT_HELP,
  LINKED_TEXT,
  NOT_LINKED_TEXT,
  PAUSED_TEXT,
  RESUMED_TEXT,
  SEARCHES_TEXT,
  helpKeyboard,
  isBareStart,
  isHelpCommand,
  isPauseCommand,
  isResumeCommand,
  isSearchesCommand,
  parsePauseCallback,
  parseSkipCallback,
  parseStartCommand,
  webhookAuthorized,
} from "@/io/telegram";
import { originOf } from "@/server/secrets";
import {
  bindTelegram,
  listAlerts,
  saveAlerts,
  setTelegramPaused,
  telegramOwner,
  telegramPaused,
} from "@/server/radar-store";

export const dynamic = "force-dynamic";

type Update = {
  message?: { text?: string; chat?: { id?: number } };
  callback_query?: { data?: string; id?: string; message?: { chat?: { id?: number } } };
};

export async function POST(request: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
  if (!webhookAuthorized(request.headers.get("x-telegram-bot-api-secret-token"), expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const update = (await request.json().catch(() => null)) as Update | null;
  const kv = getKv();
  const origin = originOf(request);
  const text = update?.message?.text ?? "";
  const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (chatId !== undefined && token && (isHelpCommand(text) || isBareStart(text))) {
    const owner = await telegramOwner(kv, String(chatId));
    const paused = owner ? await telegramPaused(kv, owner) : false;
    await send(token, chatId, CONNECT_HELP, helpKeyboard(origin, paused));
  }

  if (chatId !== undefined && token && isSearchesCommand(text)) {
    const owner = await telegramOwner(kv, String(chatId));
    const paused = owner ? await telegramPaused(kv, owner) : false;
    await send(token, chatId, SEARCHES_TEXT, helpKeyboard(origin, paused));
  }

  const pauseWord = isPauseCommand(text) ? "pause" : isResumeCommand(text) ? "resume" : null;
  const pauseData = update?.callback_query?.data ? parsePauseCallback(update.callback_query.data) : null;
  const pauseAction = pauseWord ?? pauseData;
  if (chatId !== undefined && token && pauseAction) {
    const owner = await telegramOwner(kv, String(chatId));
    if (!owner) {
      await send(token, chatId, NOT_LINKED_TEXT);
    } else if (pauseAction === "pause") {
      await setTelegramPaused(kv, owner, true);
      await send(token, chatId, PAUSED_TEXT, helpKeyboard(origin, true));
    } else {
      await setTelegramPaused(kv, owner, false);
      await send(token, chatId, RESUMED_TEXT, helpKeyboard(origin, false));
    }
    if (update?.callback_query?.id) await answer(token, update.callback_query.id, pauseAction === "pause" ? "Paused" : "Resumed");
  }

  const code = text ? parseStartCommand(text) : null;
  if (code && chatId !== undefined) {
    const bound = await bindTelegram(kv, code, String(chatId));
    if (token) {
      const reply = bound.ok ? LINKED_TEXT : bound.reason === "expired" ? CODE_EXPIRED : CODE_USED;
      await send(token, chatId, reply, bound.ok ? helpKeyboard(origin, false) : undefined);
    }
  }

  const skipId = update?.callback_query?.data ? parseSkipCallback(update.callback_query.data) : null;
  if (skipId) {
    const owner = chatId !== undefined ? await telegramOwner(kv, String(chatId)) : null;
    const alerts = await listAlerts(kv);
    for (const alert of alerts) {
      if (alert.id === skipId && (!owner || alert.ownerId === owner)) alert.status = "skipped";
    }
    await saveAlerts(kv, alerts);
    if (token && update?.callback_query?.id) await answer(token, update.callback_query.id, "Not for me");
  }
  return Response.json({ ok: true });
}

async function send(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: { inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>> },
) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
  }).catch(() => undefined);
}

async function answer(token: string, id: string, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text }),
  }).catch(() => undefined);
}
