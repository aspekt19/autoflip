import { getKv } from "@/io/kv";
import { runtimeDeps } from "@/server/deps";
import { runResaleChatTurn } from "@/server/resale-chat";
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
      { ok: false, error: "not_configured", message: "Resale chat needs SERV and listing search configured." },
      { status: 503 },
    );
  }
  const result = await runResaleChatTurn({
    kv: getKv(),
    userId: access.id,
    sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
    message: typeof body.message === "string" ? body.message : null,
    continue: body.continue === true,
    servKey: deps.servKey,
    autodevKey: deps.autodevKey,
    servBaseUrl: deps.servBaseUrl,
  });
  return Response.json(result.body, { status: result.status });
}
