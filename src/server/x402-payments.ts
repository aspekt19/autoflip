import { randomBytes, createHash } from "node:crypto";
import { importJWK, importPKCS8, SignJWT } from "jose";
import {
  HTTPFacilitatorClient,
  x402ResourceServer,
} from "@x402/core/server";
import {
  x402HTTPResourceServer,
  withPrivateCacheControl,
  type HTTPAdapter,
  type HTTPRequestContext,
  type HTTPTransportContext,
  type RouteConfig,
} from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { creditPack } from "@/domain/assumptions";
import { planById } from "@/domain/plans";

export const X402_NETWORK = "eip155:8453";
export const X402_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const X402_DEFAULT_PAY_TO = "0x250aC40Ab38E4f023c33C1c3DFD0Cd07357Fbf79";
export const X402_REPORT_PRICE_USD = 3;
const CDP_FACILITATOR_DEFAULT = "https://api.cdp.coinbase.com/platform/v2/x402";

type X402OperationResult = {
  response: Response;
  /** Runs only after the facilitator confirms settlement. */
  afterSettlement?: () => Promise<Response | void>;
  /** Reverses only pre-settlement work if settlement fails. */
  rollback?: () => Promise<void>;
};

type X402Operation = (input: { payer: string; paymentId: string }) => Promise<X402OperationResult>;

let serverPromise: Promise<x402HTTPResourceServer> | null = null;

function payToAddress(): string {
  const address = process.env.X402_PAY_TO_ADDRESS?.trim() || X402_DEFAULT_PAY_TO;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("X402_PAY_TO_ADDRESS must be a 20-byte EVM address.");
  return address;
}

export function isX402Configured(): boolean {
  return Boolean(
    process.env.CDP_API_KEY_ID?.trim() &&
    process.env.CDP_API_KEY_SECRET?.trim() &&
    /^0x[a-fA-F0-9]{40}$/.test(process.env.X402_PAY_TO_ADDRESS?.trim() || X402_DEFAULT_PAY_TO),
  );
}

function facilitatorBase(): string {
  return (process.env.X402_FACILITATOR_URL?.trim() || CDP_FACILITATOR_DEFAULT).replace(/\/+$/, "");
}

async function cdpJwt(method: "GET" | "POST", path: string): Promise<string> {
  const apiKeyId = process.env.CDP_API_KEY_ID?.trim();
  const keySecret = process.env.CDP_API_KEY_SECRET?.replace(/\\n/g, "\n").trim();
  if (!apiKeyId || !keySecret) throw new Error("Missing CDP_API_KEY_ID or CDP_API_KEY_SECRET.");
  const base = new URL(facilitatorBase());
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "cdp",
    sub: apiKeyId,
    uris: [`${method} ${base.host}${path}`],
  };
  const nonce = randomBytes(16).toString("hex");
  const decoded = Buffer.from(keySecret, "base64");
  if (!keySecret.includes("BEGIN") && decoded.length === 64) {
    const signingKey = await importJWK({
      kty: "OKP",
      crv: "Ed25519",
      d: decoded.subarray(0, 32).toString("base64url"),
      x: decoded.subarray(32).toString("base64url"),
    }, "EdDSA");
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "EdDSA", kid: apiKeyId, typ: "JWT", nonce })
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 120)
      .sign(signingKey);
  }
  const signingKey = await importPKCS8(keySecret, "ES256");
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: apiKeyId, typ: "JWT", nonce })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 120)
    .sign(signingKey);
}

async function createFacilitator(): Promise<HTTPFacilitatorClient> {
  const base = new URL(facilitatorBase());
  const prefix = base.pathname.replace(/\/$/, "");
  const headers = async (method: "GET" | "POST", suffix: string) => ({
    Authorization: `Bearer ${await cdpJwt(method, `${prefix}/${suffix}`)}`,
  });
  return new HTTPFacilitatorClient({
    url: facilitatorBase(),
    createAuthHeaders: async () => {
      const [verify, settle, supported] = await Promise.all([
        headers("POST", "verify"),
        headers("POST", "settle"),
        headers("GET", "supported"),
      ]);
      return { verify, settle, supported };
    },
  });
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function requestBody(context: HTTPRequestContext): Promise<Record<string, unknown>> {
  return asRecord(await context.adapter.getBody?.());
}

function bodyPrice(field: string, lookup: (id: string) => { amountCents: number } | null) {
  return async (context: HTTPRequestContext) => {
    const body = await requestBody(context);
    const id = typeof body[field] === "string" ? body[field] as string : "";
    const item = lookup(id);
    // Invalid values receive a harmless challenge; the operation returns 400 and
    // the verified authorization is cancelled rather than settled.
    return usd(item?.amountCents ?? 1);
  };
}

const registrationDiscovery = declareDiscoveryExtension({
  method: "POST",
  bodyType: "json",
  input: { label: "My vehicle research agent" },
  inputSchema: {
    type: "object",
    properties: { label: { type: "string", maxLength: 40 } },
    additionalProperties: false,
  },
  output: { example: { ok: true, api_key: "af_…", scopes: ["read", "check", "find"], note: "Store the key securely; it is returned once." } },
});

const creditsDiscovery = declareDiscoveryExtension({
  method: "POST",
  bodyType: "json",
  input: { pack: "pack_3" },
  inputSchema: {
    type: "object",
    properties: { pack: { type: "string", enum: ["pack_3", "pack_10"] } },
    required: ["pack"],
    additionalProperties: false,
  },
  output: { example: { ok: true, credits_added: 3, balance: 3, payment: "settled" } },
});

const plansDiscovery = declareDiscoveryExtension({
  method: "POST",
  bodyType: "json",
  input: { planId: "radar" },
  inputSchema: {
    type: "object",
    properties: { planId: { type: "string", enum: ["radar", "radar_pro"] } },
    required: ["planId"],
    additionalProperties: false,
  },
  output: { example: { ok: true, plan: "radar", active_until: "2026-12-13T00:00:00.000Z", auto_renew: false } },
});

const reportDiscovery = declareDiscoveryExtension({
  method: "POST",
  bodyType: "json",
  input: { vin: "4T1BF1FK0EU848445" },
  inputSchema: {
    type: "object",
    properties: {
      vin: { type: "string" },
      url: { type: "string" },
      mode: { type: "string", enum: ["personal", "flip"] },
      zip: { type: "string" },
      year: { type: "integer" },
    },
    anyOf: [{ required: ["vin"] }, { required: ["url"] }],
    additionalProperties: false,
  },
  output: { example: { schemaVersion: "lemonless.agent_verdict.v1", charged: true, proofRecords: [] } },
});

const routeConfig: Record<string, RouteConfig> = {
  "POST /api/agents/register": {
    accepts: { scheme: "exact", price: "$0.01", network: X402_NETWORK, payTo: () => payToAddress() },
    description: "Register an autonomous Lemonless agent. Pay $0.01 USDC on Base and receive a one-time af_ API key.",
    mimeType: "application/json",
    serviceName: "Lemonless",
    tags: ["used-cars", "ai-agents", "agent-registration"],
    extensions: registrationDiscovery,
  },
  "POST /api/agents/billing/credits": {
    accepts: {
      scheme: "exact",
      price: bodyPrice("pack", (id) => {
        const pack = creditPack(id);
        return pack ? { amountCents: pack.amountCents } : null;
      }),
      network: X402_NETWORK,
      payTo: () => payToAddress(),
    },
    description: "Buy Lemonless report credits with USDC on Base. Requires an af_ API key.",
    mimeType: "application/json",
    serviceName: "Lemonless",
    tags: ["used-cars", "ai-agents", "credits", "reports"],
    extensions: creditsDiscovery,
  },
  "POST /api/agents/billing/plans": {
    accepts: {
      scheme: "exact",
      price: bodyPrice("planId", (id) => {
        const plan = planById(id);
        return plan ? { amountCents: plan.amountCents } : null;
      }),
      network: X402_NETWORK,
      payTo: () => payToAddress(),
    },
    description: "Buy a prepaid 30-day Lemonless Deal Radar plan using USDC on Base. Requires an af_ API key. Manual renewal; no automatic recurring charge.",
    mimeType: "application/json",
    serviceName: "Lemonless",
    tags: ["used-cars", "ai-agents", "subscription", "radar"],
    extensions: plansDiscovery,
  },
  "POST /api/v1/report": {
    accepts: {
      scheme: "exact",
      price: usd(X402_REPORT_PRICE_USD * 100),
      network: X402_NETWORK,
      payTo: () => payToAddress(),
    },
    description: "Run one full Lemonless vehicle report. Pay $3.00 USDC on Base per successful report; no API key required.",
    mimeType: "application/json",
    serviceName: "Lemonless",
    tags: ["used-cars", "vehicle-report", "vin-check", "ai-agents"],
    extensions: reportDiscovery,
  },
};

async function getServer(): Promise<x402HTTPResourceServer> {
  if (!isX402Configured()) {
    throw new Error("x402 payments are not configured. Set CDP_API_KEY_ID and CDP_API_KEY_SECRET in the deployment environment.");
  }
  if (!serverPromise) {
    serverPromise = (async () => {
      const facilitator = await createFacilitator();
      const resourceServer = new x402ResourceServer(facilitator);
      resourceServer.register(X402_NETWORK, new ExactEvmScheme());
      resourceServer.registerExtension(bazaarResourceServerExtension);
      const server = new x402HTTPResourceServer(resourceServer, routeConfig);
      await server.initialize();
      return server;
    })().catch((error) => {
      serverPromise = null;
      throw error;
    });
  }
  return serverPromise;
}

function payerFromPayload(payload: PaymentPayload): string | null {
  const payment = asRecord(payload.payload);
  const authorization = asRecord(payment.authorization);
  const payer = typeof authorization.from === "string" ? authorization.from : "";
  return /^0x[a-fA-F0-9]{40}$/.test(payer) ? payer.toLowerCase() : null;
}

function paymentIdFromPayload(payload: PaymentPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function responseFromInstructions(instructions: {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  isHtml?: boolean;
}): Response {
  const headers = new Headers(instructions.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", instructions.isHtml ? "text/html; charset=utf-8" : "application/json; charset=utf-8");
  }
  const body = instructions.body === undefined
    ? null
    : typeof instructions.body === "string"
      ? instructions.body
      : JSON.stringify(instructions.body);
  return new Response(body, { status: instructions.status, headers });
}

function adapterFor(request: Request): HTTPAdapter {
  const url = new URL(request.url);
  let bodyPromise: Promise<unknown> | null = null;
  return {
    getHeader: (name) => request.headers.get(name) ?? undefined,
    getMethod: () => request.method,
    getPath: () => url.pathname,
    getUrl: () => request.url,
    getAcceptHeader: () => request.headers.get("accept") ?? "",
    getUserAgent: () => request.headers.get("user-agent") ?? "",
    getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
    getQueryParam: (name) => {
      const values = url.searchParams.getAll(name);
      return values.length > 1 ? values : values[0];
    },
    getBody: () => {
      if (!bodyPromise) bodyPromise = request.clone().json().catch(() => null);
      return bodyPromise;
    },
  };
}

export async function withX402Payment(request: Request, operation: X402Operation): Promise<Response> {
  let http: x402HTTPResourceServer;
  try {
    http = await getServer();
  } catch (error) {
    return Response.json({
      error_code: "x402_unavailable",
      message: error instanceof Error ? error.message : "x402 payments are not available.",
      retry_safe: true,
      charged: false,
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const adapter = adapterFor(request);
  const context: HTTPRequestContext = {
    adapter,
    path: adapter.getPath(),
    decodedPath: decodeURIComponent(adapter.getPath()),
    method: adapter.getMethod(),
    paymentHeader: adapter.getHeader("payment-signature") ?? adapter.getHeader("x-payment"),
  };

  let processed;
  try {
    processed = await http.processHTTPRequest(context);
  } catch (error) {
    console.error("[x402] request processing failed", error);
    return Response.json({
      error_code: "payment_processing_failed",
      message: "The payment could not be verified.",
      charged: false,
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }

  if (processed.type === "payment-error") return responseFromInstructions(processed.response);
  if (processed.type !== "payment-verified") {
    return Response.json({
      error_code: "x402_route_mismatch",
      message: "This endpoint is not configured as an x402 resource.",
      charged: false,
    }, { status: 404 });
  }

  const payer = payerFromPayload(processed.paymentPayload);
  if (!payer) {
    const cancelled = await processed.cancellationDispatcher.cancel({
      reason: "handler_failed",
      responseStatus: 400,
    }).catch(() => undefined);
    const headers = http.createFailurePathSettlementHeaders(
      cancelled,
      processed.beforeHandlerSettlement,
      processed.paymentPayload,
    );
    return Response.json({
      error_code: "payer_missing",
      message: "The Base payment did not contain a usable payer address.",
      charged: false,
    }, { status: 400, headers });
  }

  const paymentId = paymentIdFromPayload(processed.paymentPayload);
  const transport: HTTPTransportContext = { request: context };
  let result: X402OperationResult;
  try {
    result = await operation({ payer, paymentId });
  } catch (error) {
    console.error("[x402] paid operation failed", error);
    const cancelled = await processed.cancellationDispatcher.cancel({
      reason: "handler_threw",
      error,
      responseStatus: 500,
    }).catch(() => undefined);
    const headers = http.createFailurePathSettlementHeaders(
      cancelled,
      processed.beforeHandlerSettlement,
      processed.paymentPayload,
    );
    return Response.json({
      error_code: "paid_operation_failed",
      message: "The operation failed before settlement. No successful charge was recorded.",
      charged: false,
    }, { status: 500, headers });
  }

  if (result.response.status < 200 || result.response.status >= 300) {
    if (result.rollback) await result.rollback().catch((error) => console.error("[x402] rollback failed", error));
    const cancelled = await processed.cancellationDispatcher.cancel({
      reason: "handler_failed",
      responseStatus: result.response.status,
    }).catch(() => undefined);
    const failureHeaders = http.createFailurePathSettlementHeaders(
      cancelled,
      processed.beforeHandlerSettlement,
      processed.paymentPayload,
      result.response.headers.get("cache-control"),
    );
    const headers = new Headers(result.response.headers);
    if (failureHeaders) {
      for (const [key, value] of Object.entries(failureHeaders)) headers.set(key, value);
    }
    return new Response(await result.response.clone().arrayBuffer(), {
      status: result.response.status,
      statusText: result.response.statusText,
      headers,
    });
  }

  transport.responseBody = Buffer.from(await result.response.clone().arrayBuffer());
  transport.responseHeaders = Object.fromEntries(result.response.headers.entries());

  let settlement;
  try {
    settlement = await http.processSettlement(
      processed.paymentPayload,
      processed.paymentRequirements,
      processed.declaredExtensions,
      transport,
      undefined,
      processed.beforeHandlerSettlement,
    );
  } catch (error) {
    console.error("[x402] settlement call failed", error);
    if (result.rollback) await result.rollback().catch((rollbackError) => console.error("[x402] rollback failed", rollbackError));
    return Response.json({
      error_code: "settlement_indeterminate",
      message: "The facilitator did not confirm settlement. Check the PAYMENT-RESPONSE header or transaction status before retrying.",
      charged: "unknown",
      payment_id: paymentId,
      retry_safe: false,
    }, { status: 502, headers: { "Cache-Control": "private, no-store" } });
  }

  if (!settlement.success) {
    if (result.rollback) await result.rollback().catch((error) => console.error("[x402] rollback failed", error));
    return responseFromInstructions(settlement.response);
  }

  const settlementHeaders = {
    ...settlement.headers,
    "Cache-Control": withPrivateCacheControl(result.response.headers.get("cache-control")),
  };
  let finalResponse = result.response;
  try {
    const after = await result.afterSettlement?.();
    if (after instanceof Response) finalResponse = after;
  } catch (error) {
    console.error("[x402] settlement succeeded but fulfilment failed", error);
    return Response.json({
      error_code: "payment_settled_fulfilment_pending",
      message: "Payment settled, but Lemonless could not complete the account update. Keep the payment receipt and contact support with this payment_id.",
      charged: true,
      payment_id: paymentId,
    }, { status: 503, headers: { ...settlementHeaders, "Cache-Control": "private, no-store" } });
  }

  const headers = new Headers(finalResponse.headers);
  for (const [key, value] of Object.entries(settlementHeaders)) headers.set(key, value);
  return new Response(await finalResponse.clone().arrayBuffer(), {
    status: finalResponse.status,
    statusText: finalResponse.statusText,
    headers,
  });
}

export function agentPaymentInfo(origin: string) {
  return {
    protocol: "x402-v2",
    available: isX402Configured(),
    network: X402_NETWORK,
    chain: "Base Mainnet",
    asset: "USDC",
    asset_address: X402_USDC,
    pay_to: process.env.X402_PAY_TO_ADDRESS?.trim() || X402_DEFAULT_PAY_TO,
    scheme: "exact",
    facilitator: process.env.X402_FACILITATOR_URL?.trim() || CDP_FACILITATOR_DEFAULT,
    registration: {
      method: "POST",
      url: `${origin}/api/agents/register`,
      price_usd: 0.01,
      api_key_required: false,
      description: "Register an agent wallet and receive an af_ API key.",
    },
    credits: {
      method: "POST",
      url: `${origin}/api/agents/billing/credits`,
      api_key_required: true,
      packs: [{ id: "pack_3", credits: 3, price_usd: 9 }, { id: "pack_10", credits: 10, price_usd: 25 }],
    },
    plans: {
      method: "POST",
      url: `${origin}/api/agents/billing/plans`,
      api_key_required: true,
      auto_renew: false,
      validity_days: 30,
      options: [
        { id: "radar", name: "Radar", price_usd: 100, watch_limit: 1, reviews_per_month: 300 },
        { id: "radar_pro", name: "Radar Pro", price_usd: 250, watch_limit: 3, reviews_per_month: 900 },
      ],
    },
    single_report: {
      method: "POST",
      url: `${origin}/api/v1/report`,
      price_usd: X402_REPORT_PRICE_USD,
      api_key_required: false,
      description: "One full vehicle report, paid directly by the requesting agent wallet.",
    },
    required_headers: ["PAYMENT-SIGNATURE"],
    discovery: "The 402 response includes machine-readable Bazaar input/output schemas.",
    note: "For Find and Resale runs, buy report credits first. Radar purchases are prepaid 30-day passes and must be renewed manually.",
  };
}
