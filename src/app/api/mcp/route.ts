import { randomUUID } from "node:crypto";
import { scoreRadar } from "@/domain/radar";
import { getKv } from "@/io/kv";
import { persistReport } from "@/io/persist-report";
import { paymentHeader, paymentsConfigured, readX402Config, requirementsFor, settlePayment, verifyPayment } from "@/io/x402";
import { agentAccount, invalidKeyBody, reportCreditReady, reportPaymentBody, settleReportCredit } from "@/server/agent-access";
import { agentReport } from "@/server/agent-report";
import { assembleRadar, assembleReport } from "@/server/assemble";
import { runtimeDeps } from "@/server/deps";
import {
  describeInitialize,
  isJsonRpc,
  parseMode,
  radarToolResult,
  rpcError,
  rpcResult,
  toolList,
} from "@/server/mcp";
import { bearer, originOf } from "@/server/secrets";
import { agentProof, plannedProof } from "@/server/serv";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function GET() {
  const config = readX402Config();
  return Response.json({
    name: "lemonless",
    protocol: "2025-06-18",
    transport: "json-rpc over HTTP POST",
    tools: toolList(),
    payment: {
      full_report: "1 credit with Authorization: Bearer af_…",
      deal_radar: "free",
      credits: "/credits",
      optionalHeader: paymentsConfigured(config)
        ? { scheme: config.scheme, network: config.network, priceAtomic: config.priceAtomic, facilitator: config.facilitatorUrl }
        : { configured: false },
    },
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
  const account = await agentAccount(getKv(), bearer(request));
  if (account === "invalid") {
    return Response.json(rpcError(id, -32001, invalidKeyBody().message, invalidKeyBody()), { status: 401 });
  }
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
          structuredContent: { error: result.error, message: result.message, proof: result.proof },
        }),
      );
    }
    const payload = radarToolResult(scoreRadar(result.listings, parseMode(args.mode)), result.sample, result.message, result.proof);
    return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }));
  }

  if (name === "full_report") {
    const origin = originOf(request);
    const resource = new URL("/api/v1/report", request.url).toString();
    const vin = typeof args.vin === "string" ? args.vin : "";
    const url = typeof args.url === "string" ? args.url : "";
    if (account) {
      const requestId = id === null || id === undefined ? randomUUID() : String(id);
      const idempotencyKey = `mcp:${account}:${requestId}:${vin || url}`.slice(0, 180);
      const ready = await reportCreditReady(getKv(), account, idempotencyKey, origin);
      if (!ready.ok) return Response.json(toolError(id, ready.body), { status: 402 });
      const assembled = await assembleReport(
        { mode: parseMode(args.mode), vin: vin || undefined, url: url || undefined, zip: typeof args.zip === "string" ? args.zip : undefined },
        { ...runtimeDeps(), servSurface: "agent" },
      );
      if (!assembled.ok) {
        return Response.json(
          toolError(id, {
            error: assembled.error,
            message: assembled.message,
            proof: agentProof([plannedProof("agent_guard"), plannedProof("check_rules"), plannedProof("agent_explain")], ["vin", "fairValueUsd", "priceGap"]),
          }),
        );
      }
      const settledCredit = await settleReportCredit(getKv(), account, idempotencyKey, origin);
      if (!settledCredit.ok) return Response.json(toolError(id, settledCredit.body), { status: 402 });
      await persistReport(assembled.report);
      const payload = agentReport(assembled.report);
      return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }));
    }

    const config = readX402Config();
    const provided = typeof args.payment === "string" ? args.payment : paymentHeader(request.headers);
    if (!paymentsConfigured(config) || !provided) {
      const body = reportPaymentBody(resource, origin);
      return Response.json(toolError(id, body), { status: 402 });
    }
    const requirement = requirementsFor(resource, config);
    const verified = await verifyPayment(provided, requirement, {
      fetch,
      facilitatorUrl: config.facilitatorUrl,
    });
    if (!verified.ok) {
      return Response.json(
        toolError(id, {
          error: "payment_rejected",
          message: verified.error,
          next_action: "Create a new payment and retry, or send an API key.",
          proof: agentProof([plannedProof("agent_guard")], ["fairValueUsd", "priceGap"]),
        }),
      );
    }
    // Verify funds first, but do not settle until the report has actually been built.
    const assembled = await assembleReport(
      { mode: parseMode(args.mode), vin: vin || undefined, url: url || undefined, zip: typeof args.zip === "string" ? args.zip : undefined },
      { ...runtimeDeps(), servSurface: "agent" },
    );
    if (!assembled.ok) {
      return Response.json(
        toolError(id, {
          error: assembled.error,
          message: assembled.message,
          proof: agentProof([plannedProof("agent_guard"), plannedProof("check_rules"), plannedProof("agent_explain")], ["vin", "fairValueUsd", "priceGap"]),
        }),
      );
    }
    const settled = await settlePayment(verified.verified, requirement, {
      fetch,
      facilitatorUrl: config.facilitatorUrl,
    });
    if (!settled.ok) {
      return Response.json(
        toolError(id, {
          error: "payment_rejected",
          message: settled.error,
          next_action: "Create a new payment and retry, or send an API key.",
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

function toolError(id: unknown, body: { message?: string; error?: string; [key: string]: unknown }) {
  return rpcResult(id, {
    content: [{ type: "text", text: body.message ?? body.error ?? "Request failed." }],
    isError: true,
    structuredContent: body,
  });
}
