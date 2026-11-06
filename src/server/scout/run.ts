import {
  heuristicOfflinePlanner,
  runScout,
  type ScoutBudgets,
  type ScoutRunResult,
} from "@/domain/scout";
import { runtimeDeps } from "@/server/deps";
import { blockedServPlanner, servScoutPlanner } from "./planner";
import { camryReplayInventory } from "./replay";
import { saveScoutRun } from "./store";
import type { Kv } from "@/io/kv";

export type StartScoutBody = {
  mandate: unknown;
  /** `offline_heuristic` never claims SERV autonomy. `serv` requires allow flag + key. */
  planner?: "offline_heuristic" | "serv";
  budgets?: Partial<ScoutBudgets>;
  resumeRunId?: string;
};

export async function executeScoutRun(input: {
  ownerId: string;
  body: StartScoutBody;
  kv: Kv | null;
  resume?: ScoutRunResult | null;
}): Promise<ScoutRunResult> {
  const deps = runtimeDeps();
  const plannerMode = input.body.planner ?? "offline_heuristic";
  const allowServ =
    process.env.SCOUT_ALLOW_SERV_PLANNER?.trim().toLowerCase() === "1" ||
    process.env.SCOUT_ALLOW_SERV_PLANNER?.trim().toLowerCase() === "true";

  let planner;
  let autonomyClaim: "serv_directed" | "none";

  if (plannerMode === "serv") {
    autonomyClaim = "serv_directed";
    if (!allowServ || !deps.servKey) {
      planner = blockedServPlanner();
    } else {
      planner = servScoutPlanner({
        apiKey: deps.servKey,
        baseUrl: deps.servBaseUrl,
        model: deps.servModel,
      });
    }
  } else {
    autonomyClaim = "none";
    planner = heuristicOfflinePlanner();
  }

  // Live Auto.dev remains blocked via maxProviderCalls default 0 + replay inventory.
  const inventory = camryReplayInventory();

  const result = await runScout({
    ownerId: input.ownerId,
    mandateRaw: input.body.mandate,
    budgets: {
      ...input.body.budgets,
      // Force no provider spend in this slice even if client asks.
      maxProviderCalls: 0,
    },
    inventory,
    planner,
    autonomyClaim,
    resume: input.resume ?? undefined,
  });

  await saveScoutRun(input.kv, result);
  return result;
}
