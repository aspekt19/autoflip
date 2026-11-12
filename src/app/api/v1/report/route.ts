import { randomUUID } from "node:crypto";
import { agentAccount, invalidKeyBody, reportCreditReady, reportPaymentBody, settleReportCredit } from "@/server/agent-access";
import { agentReport } from "@/server/agent-report";
import { agentProof, plannedProof } from "@/server/serv";
import { assembleReport } from "@/server/assemble";
import { runtimeDeps } from "@/server/deps";
import { parseMode } from "@/server/mcp";
import { bearer, originOf } from "@/server/secrets";
import { persistReport } from "@/io/persist-report";
import { getKv } from "@/io/kv";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const origin = originOf(request);
  const resource = new URL(request.url).toString();
  const account = await agentAccount(getKv(), bearer(request));
  if (account === "invalid") return Response.json(invalidKeyBody(), { status: 401 });
  if (account) return reportWithCredit(request, account, origin);
  return Response.json(reportPaymentBody(resource, origin), { status: 402 });
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
