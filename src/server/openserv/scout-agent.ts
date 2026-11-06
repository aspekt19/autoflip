/**
 * OpenServ SDK adapter for Lemonless Scout.
 * Capabilities invoke shared executeScoutSafely — same ownership/flag/paid gates as HTTP.
 * Local ≠ remote deployment. No blockchain/x402/swarm.
 */
import { Agent } from "@openserv-labs/sdk";
import { z } from "zod";
import { validateScoutMandate, type ScoutRunResult } from "@/domain/scout";
import { executeScoutSafely } from "@/server/scout/safe-execute";
import { readPaidExecutionConfig } from "@/server/scout/paid-execution";
import { SCOUT_TOOL_IDS } from "@/domain/scout";

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

export function buildLemonlessScoutAgent(options?: {
  apiKey?: string;
  port?: number;
  /** Test/eval override — production uses process.env via safe-execute. */
  env?: Record<string, string | undefined>;
  ownerIdForLocal?: string;
}): Agent {
  const agent = new Agent({
    systemPrompt: SCOUT_AGENT_SYSTEM_PROMPT,
    apiKey: options?.apiKey ?? process.env.OPENSERV_API_KEY,
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
      const paid = readPaidExecutionConfig(options?.env ?? process.env);
      return JSON.stringify({
        tools: SCOUT_TOOL_IDS,
        maxCandidatesOut: 5,
        paidExecutionEnabled: paid.paidExecutionEnabled,
        clientSpendAttestation: "rejected",
        remotePrerequisites: [
          "OpenServ developer account",
          "Registered agent + OPENSERV_API_KEY",
          "Public HTTPS endpoint + agent.start() only on that host",
          "SCOUT_ENABLED for HTTP; capabilities still cannot bypass paid-execution",
        ],
        notIncluded: ["blockchain", "x402", "reppo", "swarm"],
      });
    },
  });

  agent.addCapability({
    name: "scout_run_bounded",
    description:
      "Run the bounded scout loop through shared safety-checked executeScoutSafely (same gates as HTTP). Default inventory is fixture replay; live Auto.dev requires server SCOUT_PAID_EXECUTION.",
    inputSchema: z.object({
      ownerId: z.string().min(1),
      mandate: mandateSchema,
      preferLive: z.boolean().optional(),
    }),
    async run({ args, action }) {
      const env = {
        ...(options?.env ?? process.env),
        // Capabilities used from local tests may set SCOUT_ENABLED; never invent paid on.
        SCOUT_ENABLED: (options?.env ?? process.env).SCOUT_ENABLED ?? "true",
      };

      const executed = await executeScoutSafely({
        req: {
          ownerId: args.ownerId,
          mandate: args.mandate,
          preferLive: Boolean(args.preferLive),
          planner: "offline_heuristic",
          channel: "openserv_sdk",
          budgets: { maxProviderCalls: 0, maxCandidatesOut: 5 },
        },
        kv: null,
        env,
        autodevDeps: null,
      });

      if (!executed.ok) {
        return JSON.stringify({ ok: false, ...executed.body });
      }

      await maybePublishScoutArtifact(agent, action, executed.result);

      return JSON.stringify({
        ok: true,
        inventoryMode: executed.inventoryMode,
        isFixture: executed.isFixture,
        paidBlockedReason: executed.paidBlockedReason,
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
  "Capabilities call executeScoutSafely — they cannot bypass SCOUT_PAID_EXECUTION.",
] as const;
