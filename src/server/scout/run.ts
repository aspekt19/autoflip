import {
  heuristicOfflinePlanner,
  runScout,
  type ScoutBudgets,
  type ScoutRunResult,
} from "@/domain/scout";
import { runtimeDeps } from "@/server/deps";
import { blockedServPlanner, servScoutPlanner } from "./planner";
import { camryReplayInventory } from "./replay";
import { authorizeScoutSpend, spendAuthFromEnv } from "./spend-gate";
import { saveScoutRun } from "./store";
import type { Kv } from "@/io/kv";

export type StartScoutBody = {
  mandate: unknown;
  /** `offline_heuristic` never claims SERV autonomy. `serv` requires allow flag + key + spend auth. */
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
    const spend = authorizeScoutSpend(spendAuthFromEnv());
    if (!allowServ) {
      planner = blockedServPlanner(
        "SCOUT_ALLOW_SERV_PLANNER is not enabled — offline/replay only.",
      );
    } else if (!spend.ok) {
      planner = blockedServPlanner(`Paid SERV planner blocked: ${spend.message}`);
    } else if (!deps.servKey) {
      planner = blockedServPlanner("SERV_API_KEY missing — cannot run serv planner.");
    } else {
      planner = servScoutPlanner({
        apiKey: deps.servKey,
        baseUrl: deps.servBaseUrl,
        model: deps.servModel,
        spendAuth: spendAuthFromEnv(),
      });
    }
  } else {
    autonomyClaim = "none";
    planner = heuristicOfflinePlanner();
  }

  // Live Auto.dev remains blocked via maxProviderCalls forced 0 + replay inventory.
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
