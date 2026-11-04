import { scoreRadar } from "@/domain/radar";
import type { Mode } from "@/domain/types";
import { paymentsConfigured, readX402Config, requirementsFor, type PaymentRequirements } from "@/io/x402";
import { agentProof, plannedProof, type AgentProof } from "@/server/serv";

const PROTOCOL = "2025-06-18";

export function toolList() {
  return [
    {
      name: "deal_radar",
      description:
        "Free scan of current listings for one make and model. Returns a deal score from comparable asking prices in that result set. Does not charge. Recalls and fuel are not included; use full_report for those. The result always includes proof: profiles that ran, tools, model suffixes, guard result, shadow outcome and iteration cap, latency, which fields were computed in code, and any id, model, finish_reason, usage, or reasoning output the inference response included.",
      inputSchema: {
        type: "object",
        properties: {
          make: { type: "string" },
          model: { type: "string" },
          zip: { type: "string" },
          year: { type: "integer" },
          distanceMiles: { type: "integer" },
          mode: { type: "string", enum: ["personal", "flip"] },
        },
        required: ["make", "model"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: "full_report",
      description:
        "Paid AutoFlip verdict for one VIN. The price is the configured x402 amount. Ask the human before paying. Call once without a payment to read the requirements, then call again with the payment payload from a Kite Passport session. Every response includes proof: profiles that ran, tools, model suffixes, guard result, shadow outcome and iteration cap, latency, which fields were computed in code, and any id, model, finish_reason, usage, or reasoning output the inference response included.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["personal", "flip"] },
          vin: { type: "string" },
          url: { type: "string" },
          zip: { type: "string" },
          payment: { type: "string", description: "Base64 x402 payment payload after the human approves the session payment." },
        },
        required: ["mode"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  ];
}

export function paymentRequiredBody(resource: string): {
  error: string;
  message: string;
  accepts?: PaymentRequirements[];
  next_action: string;
  proof: AgentProof;
} {
  const config = readX402Config();
  const proof = agentProof([plannedProof("agent_guard"), plannedProof("check_rules"), plannedProof("agent_explain")], ["fairValueUsd", "priceGap", "score"]);
  if (!paymentsConfigured(config)) {
    return {
      error: "payments_not_configured",
      message: "The agent payment endpoint is not configured yet (payee, network, or asset is empty). No charge was attempted.",
      next_action: "Set X402_PAY_TO, X402_NETWORK, and X402_ASSET, then retry.",
      proof,
    };
  }
  return {
    error: "payment_required",
    message: "A full report is a paid request.",
    accepts: [requirementsFor(resource, config)],
    next_action:
      "Pay this resource with a Kite Passport session using the x402 requirements, then call full_report again with the payment payload.",
    proof,
  };
}

type JsonRpc = { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };

export function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

export function parseMode(value: unknown): Mode {
  return value === "flip" ? "flip" : "personal";
}

export function describeInitialize(id: unknown) {
  return rpcResult(id, {
    protocolVersion: PROTOCOL,
    capabilities: { tools: {} },
    serverInfo: { name: "autoflip", version: "0.1.0" },
  });
}

export function radarToolResult(rows: ReturnType<typeof scoreRadar>, sample: boolean, message: string | null, proof?: unknown) {
  return {
    sample,
    message,
    ...(proof !== undefined ? { proof } : {}),
    listings: rows.map((row) => ({
      vin: row.listing.vin,
      year: row.listing.year,
      make: row.listing.make,
      model: row.listing.model,
      trim: row.listing.trim,
      priceUsd: row.listing.priceUsd,
      miles: row.listing.miles,
      city: row.listing.city,
      state: row.listing.state,
      primaryImage: row.listing.primaryImage,
      score: row.score,
      verdict: row.verdict,
      reason: row.reason,
      source: row.listing.source,
    })),
  };
}

export function isJsonRpc(value: unknown): value is JsonRpc {
  return Boolean(value && typeof value === "object" && "method" in value);
}
