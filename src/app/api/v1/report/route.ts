import { agentReport } from "@/server/agent-report";
import { assembleReport } from "@/server/assemble";
import { runtimeDeps } from "@/server/deps";
import { parseMode, paymentRequiredBody } from "@/server/mcp";
import { persistReport } from "@/io/persist-report";
import { paymentHeader, paymentsConfigured, readX402Config, requirementsFor, verifyAndSettle } from "@/io/x402";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const config = readX402Config();
  const resource = new URL(request.url).toString();
  if (!paymentsConfigured(config)) {
    return Response.json(paymentRequiredBody(resource), { status: 402 });
  }
  const header = paymentHeader(request.headers);
  if (!header) {
    return Response.json(paymentRequiredBody(resource), {
      status: 402,
      headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequiredBody(resource))).toString("base64") },
    });
  }
  const requirement = requirementsFor(resource, config);
  const settled = await verifyAndSettle(header, requirement, { fetch, facilitatorUrl: config.facilitatorUrl });
  if (!settled.ok) {
    return Response.json({ error: "payment_rejected", message: settled.error, accepts: [requirement] }, { status: 402 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "invalid_json", message: "Send JSON." }, { status: 400 });
  const assembled = await assembleReport(
    {
      mode: parseMode(body.mode),
      vin: typeof body.vin === "string" ? body.vin : undefined,
      url: typeof body.url === "string" ? body.url : undefined,
      zip: typeof body.zip === "string" ? body.zip : undefined,
      year: typeof body.year === "number" ? body.year : undefined,
    },
    runtimeDeps(),
  );
  if (!assembled.ok) {
    return Response.json({ error: assembled.error, message: assembled.message, txHash: settled.txHash }, { status: assembled.status });
  }
  await persistReport(assembled.report);
  return Response.json({ ...agentReport(assembled.report), txHash: settled.txHash });
}
