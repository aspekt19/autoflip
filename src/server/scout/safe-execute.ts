/**
 * Single safety-checked entry for Scout runs (HTTP API + OpenServ SDK capabilities).
 * Capabilities must not bypass ownership, feature flags, or paid-execution gates.
 * Do not route investigation through SDK Agent.process() (hardcoded gpt-4o, not SERV).
 */
import type { ScoutRunResult } from "@/domain/scout";
import { heuristicOfflinePlanner, mockServPlanner, refusingPlanner, runScout } from "@/domain/scout";
import { TtlCache } from "@/io/cache";
import type { Kv } from "@/io/kv";
import { MemoryCounter } from "@/io/quota";
import { isScoutEnabled } from "./config";
import {
  authorizeLiveServPlanner,
  readPaidExecutionConfig,
  serverScoutBudgets,
  stripClientSpendClaims,
} from "./paid-execution";
import { blockedServPlanner, servScoutPlanner } from "./planner";
import { resolveScoutInventory } from "./providers";
import { saveScoutRun } from "./store";

export type SafeScoutRequest = {
  ownerId: string;
  mandate: unknown;
  preferLive?: boolean;
  planner?: "offline_heuristic" | "serv" | "mock_script";
  mockScript?: Parameters<typeof mockServPlanner>[0];
  resume?: ScoutRunResult | null;
  channel: "api" | "openserv_sdk" | "eval" | "test";
};

export type SafeScoutDenial = {
  ok: false;
  status: number;
  body: Record<string, unknown>;
};

export type SafeScoutOk = {
  ok: true;
  result: ScoutRunResult;
  inventoryMode: "replay" | "live";
  isFixture: boolean;
  paidBlockedReason: string | null;
};

export async function executeScoutSafely(input: {
  req: SafeScoutRequest;
  kv: Kv | null;
  env?: Record<string, string | undefined>;
  autodevDeps?: {
    fetch: typeof fetch;
    apiKey: string;
    cache?: TtlCache<unknown>;
    counter?: MemoryCounter;
  } | null;
}): Promise<SafeScoutOk | SafeScoutDenial> {
  const env = input.env ?? process.env;

  if (!isScoutEnabled(env) && input.req.channel !== "eval" && input.req.channel !== "test") {
    return {
      ok: false,
      status: 403,
      body: {
        error: "scout_disabled",
        message: "Scout is disabled (SCOUT_ENABLED default off).",
      },
    };
  }

  if (!input.req.ownerId || typeof input.req.ownerId !== "string") {
    return {
      ok: false,
      status: 401,
      body: { error: "unauthorized", message: "ownerId required for scout ownership isolation." },
    };
  }

  const mandate =
    input.req.mandate && typeof input.req.mandate === "object"
      ? stripClientSpendClaims(input.req.mandate as Record<string, unknown>)
      : input.req.mandate;

  const preferLive = Boolean(input.req.preferLive);
  const autodev =
    preferLive && input.autodevDeps?.apiKey
      ? {
          fetch: input.autodevDeps.fetch,
          apiKey: input.autodevDeps.apiKey,
          cache: input.autodevDeps.cache ?? new TtlCache<unknown>(),
          counter: input.autodevDeps.counter ?? new MemoryCounter(),
          source: "autodev" as const,
        }
      : null;

  const inventory = resolveScoutInventory({
    kv: input.kv,
    autodev,
    preferLive: preferLive && Boolean(autodev),
    env,
  });

  const plannerMode = input.req.planner ?? "offline_heuristic";
  let planner;
  let autonomyClaim: "serv_directed" | "none" = "none";

  if (plannerMode === "mock_script") {
    // Control plumbing only — not hosted SERV efficacy.
    autonomyClaim = "none";
    planner = input.req.mockScript
      ? mockServPlanner(input.req.mockScript)
      : refusingPlanner("serv_unavailable");
  } else if (plannerMode === "serv") {
    const paid = authorizeLiveServPlanner(readPaidExecutionConfig(env));
    const allowFlag =
      env.SCOUT_ALLOW_SERV_PLANNER?.trim().toLowerCase() === "1" ||
      env.SCOUT_ALLOW_SERV_PLANNER?.trim().toLowerCase() === "true";
    if (!allowFlag) {
      autonomyClaim = "none";
      planner = blockedServPlanner("SCOUT_ALLOW_SERV_PLANNER is not enabled.");
    } else if (!paid.ok) {
      autonomyClaim = "none";
      planner = blockedServPlanner(paid.message);
    } else {
      autonomyClaim = "serv_directed";
      planner = servScoutPlanner({
        apiKey: env.SERV_API_KEY!.trim(),
        baseUrl: env.SERV_BASE_URL,
        model: env.SERV_MODEL,
      });
    }
  } else {
    // Deterministic offline VIN walk — autonomyClaim none (not SERV autonomy).
    planner = heuristicOfflinePlanner();
  }

  // Server-owned budgets only — clients cannot raise maxProviderCalls/wall/serv ceilings.
  const budgets = serverScoutBudgets();

  const result = await runScout({
    ownerId: input.req.ownerId,
    mandateRaw: mandate,
    budgets: { ...budgets },
    inventory: inventory.adapter,
    planner,
    autonomyClaim,
    resume: input.req.resume ?? undefined,
  });

  if (inventory.isFixture && result.inventorySource === "replay") {
    result.message = [result.message, "INVENTORY_FIXTURE: replay rows are not live market data."]
      .filter(Boolean)
      .join(" ");
  }

  if (input.kv) await saveScoutRun(input.kv, result);

  return {
    ok: true,
    result,
    inventoryMode: inventory.mode,
    isFixture: inventory.isFixture,
    paidBlockedReason: inventory.paidBlockedReason,
  };
}
