import { randomUUID } from "node:crypto";
import { reportCreditReady, settleReportCredit } from "@/server/agent-access";
import { authenticateAgentRequest, authFailureResponse } from "@/server/agent-auth";
import { agentReport } from "@/server/agent-report";
import { agentProof, plannedProof } from "@/server/serv";
import { assembleReport } from "@/server/assemble";
import { runtimeDeps } from "@/server/deps";
import { parseMode } from "@/server/mcp";
import { bearer, originOf } from "@/server/secrets";
import { persistReport } from "@/io/persist-report";
import { getKv } from "@/io/kv";
import { withX402Payment } from "@/server/x402-payments";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const origin = originOf(request);
  const token = bearer(request);
  if (token.startsWith("af_")) {
    const auth = await authenticateAgentRequest(getKv(), request, origin, "check");
    if (!auth.ok) return authFailureResponse(auth);
    return reportWithCredit(request, auth.caller.userId, origin, auth.headers);
  }

  return withX402Payment(request, async ({ payer, paymentId }) => {
    const body = (await request.clone().json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return { response: Response.json({ error_code: "invalid_json", message: "Send JSON.", charged: false }, { status: 400 }) };
    }
    const vin = typeof body.vin === "string" ? body.vin.trim() : "";
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!vin && !url) {
      return { response: Response.json({ error_code: "missing_vehicle", message: "Send vin or url.", charged: false }, { status: 400 }) };
    }
    const assembled = await assembleReport(
      {
        mode: parseMode(body.mode),
        vin: vin || undefined,
        url: url || undefined,
        zip: typeof body.zip === "string" ? body.zip : undefined,
        year: typeof body.year === "number" ? body.year : undefined,
      },
      { ...runtimeDeps(), servSurface: "agent" as const },
    );
    if (!assembled.ok) {
      return {
        response: Response.json(
          { error: assembled.error, message: assembled.message, proof: agentProof([plannedProof("agent_guard")], ["vin", "fairValueUsd", "priceGap"]), charged: false },
          { status: assembled.status },
        ),
      };
    }

    // Persist before settlement so only a durable report can be paid and returned.
    // If settlement fails, this is an orphaned record with no client-visible id.
    await persistReport(assembled.report);
    return {
      response: Response.json({
        ...agentReport(assembled.report),
        payment: "x402",
        payment_id: paymentId,
        payer,
      }),
    };
  });
}

async function reportWithCredit(
  request: Request,
  userId: string,
  origin: string,
  rateLimitHeaders: Record<string, string>,
) {
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: rateLimitHeaders });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return reply({ error: "invalid_json", message: "Send JSON." }, 400);
  const vin = typeof body.vin === "string" ? body.vin : "";
  const url = typeof body.url === "string" ? body.url : "";
  const requestId = request.headers.get("idempotency-key")?.trim() || randomUUID();
  const idempotencyKey = `v1:${userId}:${requestId}:${vin || url}`.slice(0, 180);
  const ready = await reportCreditReady(getKv(), userId, idempotencyKey, origin);
  if (!ready.ok) return reply(ready.body, 402);
  const assembled = await assembleReport(
    {
      mode: parseMode(body.mode),
      vin: vin || undefined,
      url: url || undefined,
      zip: typeof body.zip === "string" ? body.zip : undefined,
      year: typeof body.year === "number" ? body.year : undefined,
    },
    { ...runtimeDeps(), servSurface: "agent" as const },
  );
  if (!assembled.ok) {
    return reply(
      { error: assembled.error, message: assembled.message, proof: agentProof([plannedProof("agent_guard")], ["vin", "fairValueUsd", "priceGap"]) },
      assembled.status,
    );
  }
  // Persist first: a storage failure must never consume a report credit.
  await persistReport(assembled.report);
  const settled = await settleReportCredit(getKv(), userId, idempotencyKey, origin);
  if (!settled.ok) return reply(settled.body, 402);
  return reply(agentReport(assembled.report));
}
