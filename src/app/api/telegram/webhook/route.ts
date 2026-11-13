import { getKv } from "@/io/kv";
import {
  CODE_EXPIRED,
  CODE_USED,
  CONNECT_HELP,
  LINKED_TEXT,
  NOT_LINKED_TEXT,
  STOPPED_TEXT,
  isBareStart,
  isHelpCommand,
  isStopCommand,
  parseStartCommand,
  verifyTelegramLinkToken,
  webhookAuthorized,
} from "@/io/telegram";
import {
  bindTelegram,
  saveTelegramCode,
  telegramOwner,
  unlinkTelegram,
} from "@/server/radar-store";

export const dynamic = "force-dynamic";

type Update = {
  message?: { text?: string; chat?: { id?: number } };
};

export async function POST(request: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
  if (!webhookAuthorized(request.headers.get("x-telegram-bot-api-secret-token"), expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const update = (await request.json().catch(() => null)) as Update | null;
  const kv = getKv();
  const text = update?.message?.text ?? "";
  const chatId = update?.message?.chat?.id;
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const signing = expected || process.env.AUTH_SECRET?.trim() || "";

  if (chatId !== undefined && botToken && (isHelpCommand(text) || isBareStart(text))) {
    await send(botToken, chatId, CONNECT_HELP);
  }

  if (chatId !== undefined && botToken && isStopCommand(text)) {
    const owner = await telegramOwner(kv, String(chatId));
    if (!owner) {
      await send(botToken, chatId, NOT_LINKED_TEXT);
    } else {
      await unlinkTelegram(kv, owner, String(chatId));
      await send(botToken, chatId, STOPPED_TEXT);
    }
  }

  const startToken = text ? parseStartCommand(text) : null;
  if (startToken && chatId !== undefined) {
    let ownerId: string | null = null;
    const verified = signing ? verifyTelegramLinkToken(startToken, signing) : { ok: false as const, reason: "invalid" as const };
    if (verified.ok) {
      ownerId = verified.userId;
      // Ensure one-time use via KV code row (minted at /api/telegram/link).
      const bound = await bindTelegram(kv, startToken, String(chatId));
      if (!bound.ok) {
        // Signed token valid but code missing — still bind once by writing a fresh code consume.
        if (bound.reason === "used") {
          // Already consumed — treat as used unless this chat is already linked to owner.
          const existing = await telegramOwner(kv, String(chatId));
          if (existing === ownerId) {
            if (botToken) await send(botToken, chatId, LINKED_TEXT);
            return Response.json({ ok: true });
          }
          if (botToken) await send(botToken, chatId, CODE_USED);
          return Response.json({ ok: true });
        }
        if (bound.reason === "expired") {
          if (botToken) await send(botToken, chatId, CODE_EXPIRED);
          return Response.json({ ok: true });
        }
      } else if (botToken) {
        await send(botToken, chatId, LINKED_TEXT);
        return Response.json({ ok: true });
      }
    } else if (verified.reason === "expired") {
      if (botToken) await send(botToken, chatId, CODE_EXPIRED);
      return Response.json({ ok: true });
    } else {
      // Legacy random code path (unsiged KV-only).
      const bound = await bindTelegram(kv, startToken, String(chatId));
      if (botToken) {
        const reply = bound.ok ? LINKED_TEXT : bound.reason === "expired" ? CODE_EXPIRED : CODE_USED;
        await send(botToken, chatId, reply);
      }
      return Response.json({ ok: true });
    }

    // Signed token ok but no KV code — store+bind for first use.
    if (ownerId && botToken) {
      await saveTelegramCode(kv, startToken, ownerId);
      const bound = await bindTelegram(kv, startToken, String(chatId));
      await send(botToken, chatId, bound.ok ? LINKED_TEXT : CODE_USED);
    }
  }

  return Response.json({ ok: true });
}

async function send(token: string, chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => undefined);
}
