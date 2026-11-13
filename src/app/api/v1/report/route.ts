import { randomUUID } from "node:crypto";
import { agentAccount, invalidKeyBody, reportCreditReady, settleReportCredit } from "@/server/agent-access";
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
  const account = await agentAccount(getKv(), bearer(request));
  if (account === "invalid") return Response.json(invalidKeyBody(), { status: 401 });
  if (account) return reportWithCredit(request, account, origin);

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

async function reportWithCredit(request: Request, userId: string, origin: string) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "invalid_json", message: "Send JSON." }, { status: 400 });
  const vin = typeof body.vin === "string" ? body.vin : "";
  const url = typeof body.url === "string" ? body.url : "";
  const requestId = request.headers.get("idempotency-key")?.trim() || randomUUID();
  const idempotencyKey = `v1:${userId}:${requestId}:${vin || url}`.slice(0, 180);
  const ready = await reportCreditReady(getKv(), userId, idempotencyKey, origin);
  if (!ready.ok) return Response.json(ready.body, { status: 402 });
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
    return Response.json(
      { error: assembled.error, message: assembled.message, proof: agentProof([plannedProof("agent_guard")], ["vin", "fairValueUsd", "priceGap"]) },
      { status: assembled.status },
    );
  }
  const settled = await settleReportCredit(getKv(), userId, idempotencyKey, origin);
  if (!settled.ok) return Response.json(settled.body, { status: 402 });
  await persistReport(assembled.report);
  return Response.json(agentReport(assembled.report));
}
