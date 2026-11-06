/**
 * Single safety-checked entry for Scout runs (HTTP API + OpenServ SDK capabilities).
 * Capabilities must not bypass ownership, feature flags, or paid-execution gates.
 */
import type { ScoutBudgets, ScoutRunResult } from "@/domain/scout";
import { heuristicOfflinePlanner, mockServPlanner, refusingPlanner, runScout } from "@/domain/scout";
import { TtlCache } from "@/io/cache";
import type { Kv } from "@/io/kv";
import { MemoryCounter } from "@/io/quota";
import { isScoutEnabled } from "./config";
import {
  authorizeLiveServPlanner,
  readPaidExecutionConfig,
  stripClientSpendClaims,
} from "./paid-execution";
import { blockedServPlanner, servScoutPlanner } from "./planner";
import { resolveScoutInventory } from "./providers";
import { saveScoutRun } from "./store";

export type SafeScoutRequest = {
  ownerId: string;
  mandate: unknown;
  /** Client may request live; server still decides via paid-execution config. */
  preferLive?: boolean;
  planner?: "offline_heuristic" | "serv" | "mock_script";
  /** Only for tests / eval — never from untrusted HTTP without flag. */
  mockScript?: Parameters<typeof mockServPlanner>[0];
  budgets?: Partial<ScoutBudgets>;
  resume?: ScoutRunResult | null;
  /** Caller channel — logged in provenance indirectly via message. */
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
  /** Injected Autodev deps for live path; null keeps replay-only. */
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

  // Defense: drop client spend claims if mandate bag smuggled them.
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
    autonomyClaim = "serv_directed";
    planner = input.req.mockScript
      ? mockServPlanner(input.req.mockScript)
      : refusingPlanner("serv_unavailable");
  } else if (plannerMode === "serv") {
    autonomyClaim = "serv_directed";
    const paid = authorizeLiveServPlanner(readPaidExecutionConfig(env));
    const allowFlag =
      env.SCOUT_ALLOW_SERV_PLANNER?.trim().toLowerCase() === "1" ||
      env.SCOUT_ALLOW_SERV_PLANNER?.trim().toLowerCase() === "true";
    if (!allowFlag) {
      planner = blockedServPlanner("SCOUT_ALLOW_SERV_PLANNER is not enabled.");
    } else if (!paid.ok) {
      planner = blockedServPlanner(paid.message);
    } else {
      planner = servScoutPlanner({
        apiKey: env.SERV_API_KEY!.trim(),
        baseUrl: env.SERV_BASE_URL,
        model: env.SERV_MODEL,
      });
    }
  } else {
    planner = heuristicOfflinePlanner();
  }

  const result = await runScout({
    ownerId: input.req.ownerId,
    mandateRaw: mandate,
    budgets: {
      ...input.req.budgets,
      // Force 0 live provider calls unless inventory actually resolved to live AND paid gate passed.
      maxProviderCalls: inventory.mode === "live" ? input.req.budgets?.maxProviderCalls ?? 0 : 0,
    },
    inventory: inventory.adapter,
    planner,
    autonomyClaim,
    resume: input.req.resume ?? undefined,
  });

  // Annotate honesty fields on the way out via message when fixture.
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
