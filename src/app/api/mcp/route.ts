import { randomUUID } from "node:crypto";
import { scoreRadar } from "@/domain/radar";
import { getKv } from "@/io/kv";
import { persistReport } from "@/io/persist-report";
import { creditBalance as readCredits } from "@/io/credit-book";
import { reportCreditReady, settleReportCredit } from "@/server/agent-access";
import { authenticateAgentRequest } from "@/server/agent-auth";
import { runAgentCheck } from "@/server/agent-check";
import { agentError } from "@/server/agent-envelope";
import {
  advanceAgentFindRun,
  agentFindStatusPayload,
  createAgentFindRun,
  readAgentFindRun,
} from "@/server/agent-find";
import {
  advanceAgentResaleRun,
  agentResaleResultPayload,
  agentResaleStatusPayload,
  createAgentResaleRun,
} from "@/server/agent-resale";
import {
  agentListRadarWatches,
  agentRadarCheckNow,
  agentRadarFeed,
  agentSaveRadarWatch,
} from "@/server/agent-radar";
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
import { originOf } from "@/server/secrets";
import { agentPaymentInfo } from "@/server/x402-payments";
import { agentProof, plannedProof } from "@/server/serv";
import type { AgentScope } from "@/server/agent-scopes";
import { readResaleJob } from "@/server/resale-job";
import type { WatchCriteria } from "@/domain/radar-watch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function GET() {
  return Response.json({
    name: "lemonless",
    protocol: "2025-06-18",
    transport: "json-rpc over HTTP POST",
    tools: toolList(),
    auth: {
      header: "Authorization: Bearer af_…",
      scopes: ["read", "check", "find"],
      createKey: "/developers",
    },
    payment: {
      check_car: "free monthly check allotment, else 1 credit — settle after success",
      find_cars: "1 credit after a successful search",
      resale_search: "1 credit when final Resale verdict is delivered",
      full_report: "1 credit with an af_ key, or $3 USDC direct x402 payment on /api/v1/report",
      deal_radar: "free (scan)",
      radar_watches: "plan-gated saved searches (Radar / Radar Pro)",
      credits: "/credits",
      agentPayments: "/api/agents/payment-info",
      payment_protocol: "x402-v2 exact",
      payment_network: "eip155:8453",
      payment_asset: "USDC",
      direct_report_price_usd: 3,
    },
    discovery: {
      agent: "/.well-known/agent.json",
      openapi: "/openapi.json",
      llms: "/llms.txt",
      docs: "/developers",
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
  const origin = originOf(request);
  const kv = getKv();

  const scopeForTool = (tool: string | undefined): AgentScope | null => {
    if (
      tool === "deal_radar" ||
      tool === "radar_watches" ||
      tool === "radar_save_watch" ||
      tool === "radar_check_now" ||
      tool === "radar_feed"
    ) {
      return "read";
    }
    if (tool === "check_car" || tool === "full_report") return "check";
    if (
      tool === "find_cars" ||
      tool === "find_cars_status" ||
      tool === "find_cars_result" ||
      tool === "resale_search" ||
      tool === "resale_status" ||
      tool === "resale_result"
    ) {
      return "find";
    }
    return null;
  };

  if (name === "get_payment_info") {
    const info = agentPaymentInfo(origin);
    return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info }));
  }

  const needed = scopeForTool(name);
  if (!needed) {
    return Response.json(
      rpcResult(id, {
        content: [{ type: "text", text: "Unknown tool." }],
        isError: true,
        structuredContent: agentError({
          error_code: "unknown_tool",
          message: "Unknown tool.",
          next_steps: {
            action: "list_tools",
            summary: "Call tools/list for check_car, find_cars, resale_search, radar_*, deal_radar, and full_report.",
            request: { method: "POST", url: `${origin}/api/mcp`, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
          },
        }),
      }),
    );
  }

  const auth = await authenticateAgentRequest(kv, request, origin, needed);
  if (!auth.ok) {
    return Response.json(rpcError(id, -32001, auth.body.message, auth.body), {
      status: auth.status,
      headers: auth.headers,
    });
  }

  if (name === "check_car") {
    const result = await runAgentCheck(
      auth.caller,
      {
        vin: typeof args.vin === "string" ? args.vin : null,
        url: typeof args.url === "string" ? args.url : null,
        text: typeof args.text === "string" ? args.text : null,
        optionalZip: typeof args.zip === "string" ? args.zip : null,
        idempotencyKey: typeof args.idempotencyKey === "string" ? args.idempotencyKey : id != null ? String(id) : null,
      },
      { ...runtimeDeps(), kv, origin },
    );
    if (!result.ok) {
      return Response.json(toolError(id, result.body), { status: result.status });
    }
    return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result.body) }], structuredContent: result.body }));
  }

  if (name === "find_cars") {
    const created = await createAgentFindRun(
      auth.caller,
      {
        text: typeof args.text === "string" ? args.text : "",
        mode: args.mode === "flip" ? "flip" : "personal",
        zip: typeof args.zip === "string" ? args.zip : null,
        budgetUsd: typeof args.budgetUsd === "number" ? args.budgetUsd : null,
        idempotencyKey:
          typeof args.idempotencyKey === "string"
            ? args.idempotencyKey
            : request.headers.get("idempotency-key")?.trim() || (id != null ? String(id) : null),
      },
      { ...runtimeDeps(), kv, origin },
    );
    if (!created.ok) {
      return Response.json(toolError(id, created.body), { status: created.status });
    }
    const payload = {
      run_id: created.run.run_id,
      status: created.run.status,
      current_step: created.run.current_step,
      credit_spent: false,
      next_steps: {
        action: "poll_status",
        summary: "Call find_cars_status with run_id, then find_cars_result when completed.",
        request: { method: "tools/call", name: "find_cars_status", arguments: { run_id: created.run.run_id } },
      },
    };
    return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }));
  }

  if (name === "find_cars_status" || name === "find_cars_result") {
    const runId = typeof args.run_id === "string" ? args.run_id : "";
    let run = await readAgentFindRun(kv, runId);
    if (!run || run.user_id !== auth.caller.userId) {
      return Response.json(
        toolError(
          id,
          agentError({
            error_code: "run_not_found",
            message: "No find run with that id for this API key.",
            next_steps: {
              action: "create_find",
              summary: "Call find_cars with a text request first.",
              request: { method: "tools/call", name: "find_cars", arguments: { text: "Camry under $15k" } },
            },
          }),
        ),
        { status: 404 },
      );
    }
    if (run.status !== "completed" && run.status !== "failed") {
      run = (await advanceAgentFindRun(runId, { ...runtimeDeps(), kv, origin })) ?? run;
    }
    if (name === "find_cars_status") {
      const payload = await agentFindStatusPayload(run);
      return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }));
    }
    if (run.status === "failed" && run.error) return Response.json(toolError(id, run.error), { status: 422 });
    if (!run.result) {
      const payload = { run_id: run.run_id, status: run.status, current_step: run.current_step, credit_spent: false };
      return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }));
    }
    return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(run.result) }], structuredContent: run.result }));
  }

  if (name === "resale_search") {
    const created = await createAgentResaleRun(auth.caller, args, { ...runtimeDeps(), kv, origin });
    if (!created.ok) return Response.json(toolError(id, created.body as { message?: string }), { status: created.status });
    if (created.value.kind === "replay") {
      const payload = { ...created.value.delivery, credit_spent: true, balance: created.value.balance };
      return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }));
    }
    const job = created.value.job;
    const payload = {
      job_id: job.jobId,
      status: job.status,
      step_completed: job.stepCompleted,
      credit_spent: false,
      balance: created.value.balance,
      next_steps: {
        action: "poll_resale",
        summary: "Call resale_status, then resale_result when completed.",
        request: { method: "tools/call", name: "resale_status", arguments: { job_id: job.jobId } },
      },
    };
    return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }));
  }

  if (name === "resale_status" || name === "resale_result") {
    const jobId = typeof args.job_id === "string" ? args.job_id : "";
    let job = await readResaleJob(kv, jobId);
    if (!job || job.ownerId !== auth.caller.userId) {
      return Response.json(
        toolError(
          id,
          agentError({
            error_code: "job_not_found",
            message: "No resale job with that id for this API key.",
            next_steps: {
              action: "create_resale",
              summary: "Call resale_search with budgetUsd first.",
              request: { method: "tools/call", name: "resale_search", arguments: { budgetUsd: 12_000 } },
            },
          }),
        ),
        { status: 404 },
      );
    }
    if (name === "resale_result" && job.status !== "completed" && job.status !== "failed") {
      job =
        (await advanceAgentResaleRun(jobId, auth.caller, { ...runtimeDeps(), kv, origin }, { untilDone: true })) ?? job;
    } else if (name === "resale_status" && job.status !== "completed" && job.status !== "failed") {
      job =
        (await advanceAgentResaleRun(jobId, auth.caller, { ...runtimeDeps(), kv, origin }, { untilDone: false })) ?? job;
    }
    const balance = await readCredits(kv, auth.caller.userId);
    if (name === "resale_status") {
      const payload = agentResaleStatusPayload(job, balance);
      return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }));
    }
    const payload = agentResaleResultPayload(job, balance);
    return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }));
  }

  if (name === "radar_watches") {
    const out = await agentListRadarWatches(auth.caller, { kv, origin });
    if (!out.ok) return Response.json(toolError(id, out.body), { status: out.status });
    return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out.body) }], structuredContent: out.body }));
  }

  if (name === "radar_save_watch") {
    const out = await agentSaveRadarWatch(
      auth.caller,
      {
        name: typeof args.name === "string" ? args.name : undefined,
        mode: typeof args.mode === "string" ? args.mode : undefined,
        criteria: (args.criteria ?? undefined) as (WatchCriteria & { nationwide?: boolean }) | undefined,
      },
      { kv, origin },
    );
    if (!out.ok) return Response.json(toolError(id, out.body), { status: out.status });
    return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out.body) }], structuredContent: out.body }));
  }

  if (name === "radar_check_now") {
    const out = await agentRadarCheckNow(auth.caller, {
      kv,
      origin,
      fetchImpl: fetch,
    });
    if (!out.ok) return Response.json(toolError(id, out.body), { status: out.status });
    return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out.body) }], structuredContent: out.body }));
  }

  if (name === "radar_feed") {
    const out = await agentRadarFeed(auth.caller, { kv, origin });
    if (!out.ok) return Response.json(toolError(id, out.body), { status: out.status });
    return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out.body) }], structuredContent: out.body }));
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
          structuredContent: {
            error_code: result.error,
            error: result.error,
            message: result.message,
            credit_spent: false,
            proof: result.proof,
            proofRecords: result.proofRecords,
          },
        }),
      );
    }
    const payload = radarToolResult(
      scoreRadar(result.listings, parseMode(args.mode)),
      result.sample,
      result.message,
      result.proof,
      result.proofRecords,
    );
    return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: { ...payload, credit_spent: false } }));
  }

  if (name === "full_report") {
    const resource = new URL("/api/v1/report", request.url).toString();
    const vin = typeof args.vin === "string" ? args.vin : "";
    const url = typeof args.url === "string" ? args.url : "";
    const requestId = id === null || id === undefined ? randomUUID() : String(id);
    const idempotencyKey = `mcp:${auth.caller.userId}:${requestId}:${vin || url}`.slice(0, 180);
    const ready = await reportCreditReady(kv, auth.caller.userId, idempotencyKey, origin);
    if (!ready.ok) return Response.json(toolError(id, { ...ready.body, error_code: ready.body.error, credit_spent: false }), { status: 402 });
    const assembled = await assembleReport(
      { mode: parseMode(args.mode), vin: vin || undefined, url: url || undefined, zip: typeof args.zip === "string" ? args.zip : undefined },
      { ...runtimeDeps(), servSurface: "agent" },
    );
    if (!assembled.ok) {
      return Response.json(
        toolError(id, {
          error_code: assembled.error,
          error: assembled.error,
          message: assembled.message,
          credit_spent: false,
          proof: agentProof([plannedProof("agent_guard"), plannedProof("check_rules"), plannedProof("agent_explain")], ["vin", "fairValueUsd", "priceGap"]),
        }),
      );
    }
    const settledCredit = await settleReportCredit(kv, auth.caller.userId, idempotencyKey, origin);
    if (!settledCredit.ok) {
      return Response.json(toolError(id, { ...settledCredit.body, error_code: settledCredit.body.error, credit_spent: false }), { status: 402 });
    }
    await persistReport(assembled.report);
    const payload = { ...agentReport(assembled.report), credit_spent: true, credits: 1 };
    return Response.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }));
  }

  return Response.json(
    rpcResult(id, {
      content: [{ type: "text", text: "Unknown tool." }],
      isError: true,
      structuredContent: agentError({
        error_code: "unknown_tool",
        message: "Unknown tool.",
        next_steps: {
          action: "list_tools",
          summary: "Call tools/list.",
          request: { method: "POST", url: `${origin}/api/mcp`, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
        },
      }),
    }),
  );
}

function toolError(id: unknown, body: { message?: string; error?: string; error_code?: string; [key: string]: unknown }) {
  return rpcResult(id, {
    content: [{ type: "text", text: body.message ?? body.error_code ?? body.error ?? "Request failed." }],
    isError: true,
    structuredContent: body,
  });
}
