/**
 * OpenServ SDK adapter for Lemonless Scout.
 *
 * Local integration: builds an Agent with runnable capabilities that invoke the
 * shared scout tool surface (mandate validate, replay inventory, bounded run).
 * Remote deployment requires OPENSERV_API_KEY, agent registration, and a public
 * endpoint — not claimed operational here.
 *
 * Out of scope: blockchain, x402, Reppo, swarm badges.
 */
import { Agent } from "@openserv-labs/sdk";
import { z } from "zod";
import {
  REPLAY_CAMRY_PROVENANCE,
  heuristicOfflinePlanner,
  replayInventoryAdapter,
  runScout,
  validateScoutMandate,
  type ScoutRunResult,
} from "@/domain/scout";
import fixture from "../../../fixtures/autodev-camry.json";

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
  | "scout_run_offline_replay"
  | "scout_describe_allowlist";

export function scoutCapabilityNames(): ScoutCapabilityName[] {
  return ["scout_validate_mandate", "scout_run_offline_replay", "scout_describe_allowlist"];
}

/**
 * Build a local OpenServ Agent with Lemonless scout capabilities.
 * Does not call agent.start() — that is a remote-hosting concern.
 */
export function buildLemonlessScoutAgent(options?: {
  apiKey?: string;
  port?: number;
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
      const result = validateScoutMandate(args);
      return JSON.stringify(result);
    },
  });

  agent.addCapability({
    name: "scout_describe_allowlist",
    description: "List canonical scout tool IDs and hard rules for this agent.",
    inputSchema: z.object({}),
    async run() {
      return JSON.stringify({
        tools: [
          "inventory.search",
          "listing.normalize",
          "evidence.asking_price",
          "evidence.comps_ask",
          "evidence.gov_recalls",
          "evidence.gov_fuel",
          "economics.flip_estimate",
          "economics.personal_fit",
          "gates.verify",
          "candidate.reject",
          "candidate.replace",
          "run.checkpoint",
          "run.finalize",
        ],
        maxCandidatesOut: 5,
        maxProviderCallsDefault: 0,
        inventoryReplay: REPLAY_CAMRY_PROVENANCE,
        remotePrerequisites: [
          "OpenServ developer account",
          "Registered agent + OPENSERV_API_KEY",
          "Public HTTPS endpoint pointing at this process after agent.start()",
          "Accurate capabilities description on the platform",
        ],
        notIncluded: ["blockchain", "x402", "reppo", "swarm"],
      });
    },
  });

  agent.addCapability({
    name: "scout_run_offline_replay",
    description:
      "Run the bounded scout loop against the checked-in Auto.dev Camry replay fixture. Uses offline heuristic planner (autonomyClaim=none). Does not spend Auto.dev or SERV credits.",
    inputSchema: z.object({
      ownerId: z.string().min(1).describe("Ownership isolation key for the run"),
      mandate: mandateSchema,
    }),
    async run({ args, action }) {
      const result = await runScout({
        ownerId: args.ownerId,
        mandateRaw: args.mandate,
        inventory: replayInventoryAdapter(fixture, REPLAY_CAMRY_PROVENANCE),
        planner: heuristicOfflinePlanner(),
        autonomyClaim: "none",
        budgets: { maxProviderCalls: 0, maxCandidatesOut: 5 },
      });

      // Task lifecycle hooks when platform action context is present.
      // Local runs have no workspace — failures are ignored (local ≠ remote deployment).
      await maybePublishScoutArtifact(agent, action, result);

      return JSON.stringify(summarizeRun(result));
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
    const ctx = action as {
      task?: { id?: number };
      workspace?: { id?: number };
    };
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
    inventoryProvenance: result.inventoryProvenance,
    investigationCount: result.investigation.length,
    investigation: result.investigation.map((c) => ({
      vin: c.vin,
      askingUsd: c.listing.priceUsd,
      historyStatus: c.historyStatus,
      claimsSafeBuy: c.claimsSafeBuy,
      claimsVerifiedProfit: c.claimsVerifiedProfit,
      disposition: c.disposition,
    })),
    usage: result.usage,
  };
}

/** Documented remote prerequisites — not a runtime claim. */
export const OPENSERV_REMOTE_PREREQUISITES = [
  "Create an OpenServ developer profile and register an agent.",
  "Set OPENSERV_API_KEY (and optional OPENSERV_AUTH_TOKEN from provision()).",
  "Deploy this process with a public Agent Endpoint; call agent.start() only in that host.",
  "Describe capabilities accurately so workflow task matching can find scout_* tools.",
  "Do not enable SCOUT_ALLOW_SERV_PLANNER or maxProviderCalls>0 without owner spend approval.",
] as const;
