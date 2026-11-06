import type { ScoutRunResult } from "@/domain/scout";
import type { Kv } from "@/io/kv";
import { executeScoutSafely, type SafeScoutRequest } from "./safe-execute";
import { stripClientSpendClaims } from "./paid-execution";

export type StartScoutBody = {
  mandate: unknown;
  planner?: "offline_heuristic" | "serv";
  resumeRunId?: string;
  /** Client may ask; server paid-execution config decides. Budget/spend fields stripped. */
  preferLive?: boolean;
};

export async function executeScoutRun(input: {
  ownerId: string;
  body: StartScoutBody;
  kv: Kv | null;
  resume?: ScoutRunResult | null;
}): Promise<
  | { ok: true; result: ScoutRunResult; inventoryMode: "replay" | "live"; isFixture: boolean; paidBlockedReason: string | null }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const cleaned = stripClientSpendClaims(input.body as unknown as Record<string, unknown>) as StartScoutBody;

  const req: SafeScoutRequest = {
    ownerId: input.ownerId,
    mandate: cleaned.mandate,
    planner: cleaned.planner ?? "offline_heuristic",
    preferLive: Boolean(cleaned.preferLive),
    resume: input.resume ?? null,
    channel: "api",
  };

  // Live Autodev deps only when paid flag on — authorizeLiveInventory still fail-closes
  // without verified reserve + Upstash. This worker does not exercise paid spend.
  const autodevKey = process.env.AUTODEV_API_KEY?.trim();
  const paidOn =
    process.env.SCOUT_PAID_EXECUTION?.trim().toLowerCase() === "1" ||
    process.env.SCOUT_PAID_EXECUTION?.trim().toLowerCase() === "true";

  return executeScoutSafely({
    req,
    kv: input.kv,
    autodevDeps: paidOn && autodevKey ? { fetch, apiKey: autodevKey } : null,
  });
}
