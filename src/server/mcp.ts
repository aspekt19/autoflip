import { priceBadge } from "@/domain/price-badge";
import { scoreRadar } from "@/domain/radar";
import type { Mode } from "@/domain/types";
import { paymentsConfigured, readX402Config, requirementsFor, type PaymentRequirements } from "@/io/x402";
import { agentProof, plannedProof, type AgentProof } from "@/server/serv";

const PROTOCOL = "2025-06-18";

export function toolList() {
  return [
    {
      name: "check_car",
      description:
        "Check a car by listing URL, VIN, or pasted listing text. Same path as the site /check (SERV plan/decide/second-check + decision journal in proofRecords). Uses the account’s free monthly check allotment when available, otherwise 1 report credit — settled only after success. Optional x402 v2 USDC-on-Base payment when X402_AGENT_PAYMENTS_ENABLED is on (default off). Requires a key with the check scope. Returns lemonless.agent_verdict.v1 plus proofRecords (lemonless.decision_proof.v1).",
      inputSchema: {
        type: "object",
        properties: {
          vin: { type: "string" },
          url: { type: "string", description: "Public listing URL" },
          text: { type: "string", description: "Pasted listing text when the site blocks fetch" },
          zip: { type: "string" },
          payment: {
            type: "string",
            description: "Optional base64 x402 PAYMENT-SIGNATURE (only when agent x402 payments are enabled).",
          },
          idempotencyKey: { type: "string" },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: "find_cars",
      description:
        "Start an async Find from a natural-language buyer request. Same decide path as the site (free-gov → find_triage → find_decide → find_challenge / POST /api/find/decide). Returns run_id; poll find_cars_status / find_cars_result. Completed results include proofRecords + decision journal rows. Costs 1 report credit after a successful search (or optional x402 settle-on-delivery when enabled). Requires the find scope. Idempotency-Key / arguments.idempotencyKey supported.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Natural-language car request" },
          mode: { type: "string", enum: ["personal", "flip"] },
          zip: { type: "string" },
          budgetUsd: { type: "number" },
          idempotencyKey: { type: "string" },
          payment: {
            type: "string",
            description: "Optional base64 x402 PAYMENT-SIGNATURE (only when agent x402 payments are enabled).",
          },
        },
        required: ["text"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: "find_cars_status",
      description: "Poll current_step for a find_cars run_id.",
      inputSchema: {
        type: "object",
        properties: { run_id: { type: "string" } },
        required: ["run_id"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: "find_cars_result",
      description: "Get the completed find_cars result for a run_id (advances the run if still queued).",
      inputSchema: {
        type: "object",
        properties: { run_id: { type: "string" } },
        required: ["run_id"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: "deal_radar",
      description:
        "Deal Radar make/model listing scan (same price rating as the site). Scope: read. Does not create or unlock a saved watch — saved Deal Radar watches require a paid Radar or Radar Pro plan on the signed-in /radar page (cron). This MCP call does not debit report credits. Always returns exactly one radar_guard row in proofRecords (ok, skipped_no_key when SERV_API_KEY is missing, or failed with the real reason). Recalls and fuel are not included; use full_report or check_car for those.",
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
      name: "resale_search",
      description:
        "Start a Resale (flip) search from a budget — same stepped SERV plan/decide/journal path as /resale. Returns job_id; poll resale_status / resale_result. Costs 1 report credit only when the final verdict is delivered. Scope: find. Idempotency-Key / arguments.idempotencyKey supported.",
      inputSchema: {
        type: "object",
        properties: {
          budgetUsd: { type: "number", description: "Buy budget in US dollars" },
          zip: { type: "string" },
          distanceMiles: { type: "number" },
          bodyStyle: { type: "string" },
          targetProfitUsd: { type: "number" },
          idempotencyKey: { type: "string" },
        },
        required: ["budgetUsd"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: "resale_status",
      description: "Poll Resale job status / decision journal for a job_id from resale_search.",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: "resale_result",
      description:
        "Advance and fetch Resale result (same report + decision journal as the site). Advances remaining steps when still running.",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: "radar_watches",
      description:
        "List saved Deal Radar watches for the API key owner (same as /radar). Scope: read. Requires a paid Radar / Radar Pro plan to create watches; listing is free.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: "radar_save_watch",
      description:
        "Save a Deal Radar watch (criteria + mode). Same plan gates as the site ($100 Radar / $250 Radar Pro on Stripe TEST). Scope: read.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          mode: { type: "string", enum: ["personal", "flip"] },
          criteria: {
            type: "object",
            properties: {
              priceMax: { type: "number" },
              zip: { type: "string" },
              radiusMiles: { type: "number" },
              make: { type: "string" },
              model: { type: "string" },
              nationwide: { type: "boolean" },
            },
          },
        },
        required: ["criteria"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: "radar_check_now",
      description:
        "Run Deal Radar check-now for the owner's enabled watches (same SERV plan/decide path + decision journal as the site). Scope: read. Does not debit report credits.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: "radar_feed",
      description: "List recent Deal Radar alerts for the API key owner. Scope: read.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: "full_report",
      description:
        "Full Lemonless analysis for one VIN. Costs 1 credit on the account that owns the API key. Send Authorization: Bearer af_…. Requires the check scope. A zero balance returns insufficient_credits and does not run the analysis. Optional x402 PAYMENT-SIGNATURE when X402_AGENT_PAYMENTS_ENABLED is on (disabled by default).",
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
      "Pay this resource using the x402 requirements, then call full_report again with the payment payload.",
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
    serverInfo: { name: "lemonless", version: "0.1.0" },
  });
}

export function radarToolResult(
  rows: ReturnType<typeof scoreRadar>,
  sample: boolean,
  message: string | null,
  proof?: unknown,
  proofRecords?: import("@/domain/decision-proof-record").DecisionProofRecord[],
) {
  const pool = rows.map((row) => row.listing);
  return {
    sample,
    message,
    ...(proof !== undefined ? { proof } : {}),
    /** Shared lemonless.decision_proof.v1 — assembleRadar always supplies one radar_guard row. */
    proofRecords: proofRecords ?? [],
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
      badge: priceBadge(row.listing, pool),
    })),
  };
}

export function isJsonRpc(value: unknown): value is JsonRpc {
  return Boolean(value && typeof value === "object" && "method" in value);
}
