import { paymentHeader, paymentsConfigured, readX402Config, requirementsFor, verifyAndSettle } from "@/io/x402";
import { paymentRequiredBody } from "@/server/mcp";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const config = readX402Config();
  if (config.network && config.network !== "kite-testnet") {
    return Response.json({ error: "testnet_only", message: "This ticket accepts kite-testnet only." }, { status: 403 });
  }
  const resource = new URL(request.url).toString();
  if (!paymentsConfigured(config)) {
    return Response.json(paymentRequiredBody(resource), { status: 402 });
  }
  const header = paymentHeader(request.headers);
  if (!header) return Response.json(paymentRequiredBody(resource), { status: 402 });
  const settled = await verifyAndSettle(header, requirementsFor(resource, config), {
    fetch,
    facilitatorUrl: config.facilitatorUrl,
  });
  if (!settled.ok) return Response.json({ error: "payment_rejected", message: settled.error }, { status: 402 });
  return Response.json({ ok: true, ticket: "radar-cycle", txHash: settled.txHash });
}
