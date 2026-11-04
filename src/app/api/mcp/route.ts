import { scoreRadar } from "@/domain/radar";
import { agentReport } from "@/server/agent-report";
import { assembleRadar, assembleReport } from "@/server/assemble";
import { runtimeDeps } from "@/server/deps";
import {
  describeInitialize,
  isJsonRpc,
  parseMode,
  paymentRequiredBody,
  radarToolResult,
  rpcError,
  rpcResult,
  toolList,
} from "@/server/mcp";
import { persistReport } from "@/io/persist-report";
import { paymentHeader, paymentsConfigured, readX402Config, requirementsFor, verifyAndSettle } from "@/io/x402";

export const dynamic = "force-dynamic";

export function GET() {
  const config = readX402Config();
  return Response.json({
    name: "autoflip",
    protocol: "2025-06-18",
    transport: "json-rpc over HTTP POST",
    tools: toolList(),
    payment: paymentsConfigured(config)
      ? { scheme: config.scheme, network: config.network, priceAtomic: config.priceAtomic, facilitator: config.facilitatorUrl }
      : { configured: false },
  });
}

export async function POST(request: Request) {
  const message = await request.json().catch(() => null);
  if (!isJsonRpc(message) || !message.method) {
    return Response.json(rpcError(null, -32600, "Invalid JSON-RPC request."), { status: 400 });
  }
  const id = message.id ?? null;
  if (message.method === "initialize") return Response.json(describeInitialize(id));
  if (message.method === "ping") return Response.json(rpcResult(id, {}));
  if (message.method === "tools/list") return Response.json(rpcResult(id, { tools: toolList() }));
  if (message.method !== "tools/call") return Response.json(rpcError(id, -32601, "Method not found."));

  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  if (name === "deal_radar") {
    const result = await assembleRadar(
      {
        make: String(args.make ?? ""),
        model: String(args.model ?? ""),
        zip: typeof args.zip === "string" ? args.zip : undefined,
        year: typeof args.year === "number" ? args.year : undefined,
        distanceMiles: typeof args.distanceMiles === "number" ? args.distanceMiles : undefined,
        mode: parseMode(args.mode),
      },
      runtimeDeps(),
    );
    if (!result.ok) {
      return Response.json(
        rpcResult(id, {
          content: [{ type: "text", text: result.message }],
          isError: true,
          structuredContent: { error: result.error, message: result.message },
        }),
      );
    }
    const payload = radarToolResult(scoreRadar(result.listings, parseMode(args.mode)), result.sample, result.message);
    return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }));
  }

  if (name === "full_report") {
    const resource = new URL("/api/v1/report", request.url).toString();
    const config = readX402Config();
    const provided = typeof args.payment === "string" ? args.payment : paymentHeader(request.headers);
    if (!paymentsConfigured(config) || !provided) {
      const body = paymentRequiredBody(resource);
      return Response.json(
        rpcResult(id, {
          content: [{ type: "text", text: body.message }],
          isError: true,
          structuredContent: body,
        }),
      );
    }
    const settled = await verifyAndSettle(provided, requirementsFor(resource, config), {
      fetch,
      facilitatorUrl: config.facilitatorUrl,
    });
    if (!settled.ok) {
      return Response.json(
        rpcResult(id, {
          content: [{ type: "text", text: settled.error }],
          isError: true,
          structuredContent: { error: "payment_rejected", message: settled.error, next_action: "Create a new payment and retry." },
        }),
      );
    }
    const assembled = await assembleReport(
      {
        mode: parseMode(args.mode),
        vin: typeof args.vin === "string" ? args.vin : undefined,
        url: typeof args.url === "string" ? args.url : undefined,
        zip: typeof args.zip === "string" ? args.zip : undefined,
      },
      runtimeDeps(),
    );
    if (!assembled.ok) {
      return Response.json(
        rpcResult(id, {
          content: [{ type: "text", text: assembled.message }],
          isError: true,
          structuredContent: { error: assembled.error, message: assembled.message, txHash: settled.txHash },
        }),
      );
    }
    await persistReport(assembled.report);
    const payload = { ...agentReport(assembled.report), txHash: settled.txHash };
    return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }));
  }

  return Response.json(
    rpcResult(id, {
      content: [{ type: "text", text: "Unknown tool." }],
      isError: true,
      structuredContent: { error: "unknown_tool", next_action: "Use deal_radar or full_report." },
    }),
  );
}
