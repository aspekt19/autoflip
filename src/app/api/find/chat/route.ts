/**
 * POST /api/find/chat
 *
 * One SERV chat window for Find. Shopper messages are opaque to code.
 * SERV asks (ask_shopper), searches, and delivers a verdict in the same conversation.
 * Credit charges only when a verdict is delivered.
 */
import { getKv } from "@/io/kv";
import { runtimeDeps } from "@/server/deps";
import { runFindChatTurn } from "@/server/find-chat";
import { requireVerifiedAccountForFind } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const access = await requireVerifiedAccountForFind();
  if (!access.ok) return access.response;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return Response.json({ ok: false, error: "invalid_body", message: "JSON body required." }, { status: 400 });
  }

  const deps = runtimeDeps();
  if (!deps.servKey || !deps.autodevKey) {
    return Response.json(
      {
        ok: false,
        error: "not_configured",
        message: "Find chat needs SERV and listing search configured.",
      },
      { status: 503 },
    );
  }

  const result = await runFindChatTurn({
    kv: getKv(),
    userId: access.id,
    sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
    message: typeof body.message === "string" ? body.message : null,
    continue: body.continue === true,
    confirmBrief: body.confirmBrief === true,
    servKey: deps.servKey,
    autodevKey: deps.autodevKey,
    servBaseUrl: deps.servBaseUrl,
  });

  return Response.json(result.body, { status: result.status });
}
