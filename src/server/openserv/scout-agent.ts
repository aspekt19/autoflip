/**
 * OpenServ SDK adapter for Lemonless Scout.
 * Capabilities invoke shared executeScoutSafely — same gates as HTTP.
 * Do NOT use Agent.process() for investigation (hardcodes OpenAI gpt-4o; not SERV Reasoning).
 * Local ≠ remote deployment. Graph banned. No blockchain/x402/swarm.
 */
import { Agent } from "@openserv-labs/sdk";
import { z } from "zod";
import { validateScoutMandate, SCOUT_TOOL_IDS, type ScoutRunResult } from "@/domain/scout";
import { executeScoutSafely } from "@/server/scout/safe-execute";
import { isScoutEnabled } from "@/server/scout/config";
import { readPaidExecutionConfig } from "@/server/scout/paid-execution";

export const SCOUT_AGENT_SYSTEM_PROMPT = [
  "You are Lemonless Scout on OpenServ.",
  "Choose only allowlisted scout tools.",
  "Asking prices are seller claims; never invent sold prices or verified title history.",
  "Unknown history may allow an investigation candidate but forbids verified safe buy/profit claims.",
  "If you cannot proceed, abstain or error explicitly — do not silently substitute deterministic autonomy while claiming SERV direction.",
].join(" ");

const mandateSchema = z.object({
  mode: z.enum(["personal", "flip"]),
  budgetUsd: z.number().nonnegative().nullable().optional(),
  budgetKnown: z.boolean().optional(),
  targetProfitUsd: z.number().nonnegative().nullable().optional(),
  repairAbility: z.enum(["none", "minor", "major", "unknown"]).optional(),
  preferredMakes: z.array(z.string()).optional(),
  openToOtherMakes: z.boolean().optional(),
  zip: z.string().nullable().optional(),
  maxDistanceMiles: z.number().nonnegative().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export type ScoutCapabilityName =
  | "scout_validate_mandate"
  | "scout_run_bounded"
  | "scout_describe_allowlist";

export function scoutCapabilityNames(): ScoutCapabilityName[] {
  return ["scout_validate_mandate", "scout_run_bounded", "scout_describe_allowlist"];
}

/** Resolve owner from platform task/action context — never trust free-form ownerId alone for paid paths. */
export function ownerFromActionContext(
  action: unknown,
  argsOwnerId: string | undefined,
): { ok: true; ownerId: string; binding: "task" | "args_test_only" } | { ok: false; message: string } {
  const ctx = action as {
    task?: { id?: number; assigneeAgentId?: number };
    workspace?: { id?: number };
    me?: { id?: number };
  };
  const workspaceId = ctx.workspace?.id;
  const taskId = ctx.task?.id;
  const agentId = ctx.me?.id ?? ctx.task?.assigneeAgentId;
  if (typeof workspaceId === "number" && typeof taskId === "number") {
    return {
      ok: true,
      ownerId: `openserv:ws:${workspaceId}:task:${taskId}:agent:${agentId ?? "unknown"}`,
      binding: "task",
    };
  }
  // Local/unit runs without platform action: allow args owner only when SCOUT_ENABLED and clearly test-shaped.
  if (argsOwnerId && (argsOwnerId.startsWith("test:") || argsOwnerId.startsWith("eval:"))) {
    return { ok: true, ownerId: argsOwnerId, binding: "args_test_only" };
  }
  return {
    ok: false,
    message:
      "Scout capability requires OpenServ task/workspace binding (or test:/eval: ownerId in offline tests). Untrusted ownerId args are rejected.",
  };
}

export function buildLemonlessScoutAgent(options?: {
  apiKey?: string;
  port?: number;
  env?: Record<string, string | undefined>;
}): Agent {
  const env = options?.env ?? process.env;
  const agent = new Agent({
    systemPrompt: SCOUT_AGENT_SYSTEM_PROMPT,
    apiKey: options?.apiKey ?? env.OPENSERV_API_KEY,
    port: options?.port,
    onError: (error) => {
      console.error("[openserv-scout]", error.message);
    },
  });

  agent.addCapability({
    name: "scout_validate_mandate",
    description: "Validate a Lemonless personal/flip scout mandate without side effects.",
    inputSchema: mandateSchema,
    async run({ args }) {
      return JSON.stringify(validateScoutMandate(args));
    },
  });

  agent.addCapability({
    name: "scout_describe_allowlist",
    description: "List canonical scout tool IDs, paid-execution posture, and hard rules.",
    inputSchema: z.object({}),
    async run() {
      const paid = readPaidExecutionConfig(env);
      return JSON.stringify({
        tools: SCOUT_TOOL_IDS,
        maxCandidatesOut: 5,
        scoutEnabled: isScoutEnabled(env),
        paidExecutionEnabled: paid.paidExecutionEnabled,
        clientSpendAttestation: "rejected",
        note: "Agent.process() is not used for investigation — SERV Reasoning HTTP only when paid path authorized.",
        notIncluded: ["blockchain", "x402", "reppo", "swarm", "graph"],
      });
    },
  });

  agent.addCapability({
    name: "scout_run_bounded",
    description:
      "Run the bounded scout loop through shared safety-checked executeScoutSafely. Default inventory is fixture replay; live Auto.dev requires server paid-execution + verified reserve.",
    inputSchema: z.object({
      ownerId: z.string().min(1).optional().describe("Only for offline test:/eval: owners; platform tasks bind identity from action context."),
      mandate: mandateSchema,
      preferLive: z.boolean().optional(),
    }),
    async run({ args, action }) {
      if (!isScoutEnabled(env)) {
        return JSON.stringify({
          ok: false,
          error: "scout_disabled",
          message: "SCOUT_ENABLED is off — capability refuses (no default-on bypass).",
        });
      }

      const owner = ownerFromActionContext(action, args.ownerId);
      if (!owner.ok) {
        return JSON.stringify({ ok: false, error: "unauthorized", message: owner.message });
      }

      const preferLive = Boolean(args.preferLive);
      const executed = await executeScoutSafely({
        req: {
          ownerId: owner.ownerId,
          mandate: args.mandate,
          preferLive,
          planner: "offline_heuristic",
          channel: "openserv_sdk",
        },
        kv: null,
        env,
        // Never pass live Autodev deps from SDK callback without server paid path wiring.
        autodevDeps: null,
      });

      if (!executed.ok) {
        return JSON.stringify({ ok: false, ...executed.body });
      }

      await maybePublishScoutArtifact(agent, action, executed.result);

      return JSON.stringify({
        ok: true,
        ownerBinding: owner.binding,
        inventoryMode: executed.inventoryMode,
        isFixture: executed.isFixture,
        paidBlockedReason:
          executed.paidBlockedReason ??
          (preferLive
            ? "Live inventory requested but Autodev deps were not wired for this SDK channel / paid path fail-closed."
            : null),
        summary: summarizeRun(executed.result),
      });
    },
  });

  return agent;
}

async function maybePublishScoutArtifact(
  agent: Agent,
  action: unknown,
  result: ScoutRunResult,
): Promise<void> {
  try {
    const ctx = action as { task?: { id?: number }; workspace?: { id?: number } };
    const taskId = ctx.task?.id;
    const workspaceId = ctx.workspace?.id;
    if (typeof taskId !== "number" || typeof workspaceId !== "number") return;

    await agent.updateTaskStatus({
      workspaceId,
      taskId,
      status: result.state === "failed" ? "error" : "done",
    });
    await agent.uploadFile({
      workspaceId,
      path: `scout/${result.runId}.json`,
      file: JSON.stringify(summarizeRun(result), null, 2),
      taskIds: [taskId],
      skipSummarizer: true,
    });
    if (result.state === "failed") {
      await agent.markTaskAsErrored({
        workspaceId,
        taskId,
        error: result.message ?? result.failReason ?? "scout_failed",
      });
      return;
    }
    await agent.completeTask({
      workspaceId,
      taskId,
      output: JSON.stringify(summarizeRun(result)),
    });
  } catch {
    /* no remote workspace */
  }
}

export function summarizeRun(result: ScoutRunResult) {
  return {
    runId: result.runId,
    state: result.state,
    autonomyClaim: result.autonomyClaim,
    failReason: result.failReason,
    message: result.message,
    inventorySource: result.inventorySource,
    inventoryProvenance: result.inventoryProvenance,
    investigationCount: result.investigation.length,
    investigation: result.investigation.map((c) => ({
      vin: c.vin,
      askingUsd: c.listing.priceUsd,
      historyStatus: c.historyStatus,
      claimsSafeBuy: c.claimsSafeBuy,
      claimsVerifiedProfit: c.claimsVerifiedProfit,
      disposition: c.disposition,
      listingSource: c.listing.source,
    })),
    usage: result.usage,
  };
}

export const OPENSERV_REMOTE_PREREQUISITES = [
  "Create an OpenServ developer profile and register an agent.",
  "Set OPENSERV_API_KEY (separate from SERV_API_KEY).",
  "Deploy with public Agent Endpoint; call agent.start() only there.",
  "Do not use Agent.process() for Lemonless investigation (not SERV Reasoning).",
  "Capabilities call executeScoutSafely — they cannot bypass SCOUT_PAID_EXECUTION / verified reserve.",
] as const;
