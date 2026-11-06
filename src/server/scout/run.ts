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
  signal?: AbortSignal | null;
  idempotencyKey?: string | null;
}): Promise<
  | {
      ok: true;
      result: ScoutRunResult;
      inventoryMode: "replay" | "live";
      isFixture: boolean;
      paidBlockedReason: string | null;
      idempotentReplay?: boolean;
    }
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
    idempotencyKey: input.idempotencyKey ?? null,
  };

  // Autodev deps may be wired when flag+key present, but authorizeLiveInventory stays
  // non-bypassably blocked without a non-env authority (production never passes testAuthority).
  const autodevKey = process.env.AUTODEV_API_KEY?.trim();
  const paidOn =
    process.env.SCOUT_PAID_EXECUTION?.trim().toLowerCase() === "1" ||
    process.env.SCOUT_PAID_EXECUTION?.trim().toLowerCase() === "true";

  return executeScoutSafely({
    req,
    kv: input.kv,
    signal: input.signal,
    // Production: no testAuthority — env fake balances cannot open live spend.
    testAuthority: null,
    autodevDeps: paidOn && autodevKey ? { fetch, apiKey: autodevKey } : null,
  });
}
