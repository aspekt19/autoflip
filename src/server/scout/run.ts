import type { ScoutRunResult } from "@/domain/scout";
import type { Kv } from "@/io/kv";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { executeScoutSafely, type SafeScoutRequest } from "./safe-execute";
import {
  stripClientSpendClaims,
  type PaidSpendAuthority,
} from "./paid-execution";

export type StartScoutBody = {
  mandate: unknown;
  planner?: "offline_heuristic" | "serv";
  resumeRunId?: string;
  /** Client may ask; server paid-execution config decides. Budget/spend fields stripped. */
  preferLive?: boolean;
};

/**
 * Test/integration harness deps. Production HTTP must omit every field.
 * Never constructed from client body / env attestation strings.
 */
export type ScoutRunHarness = {
  env?: Record<string, string | undefined>;
  testAuthority?: PaidSpendAuthority | null;
  autodevDeps?: {
    fetch: typeof fetch;
    apiKey: string;
    cache?: TtlCache<unknown>;
    counter?: MemoryCounter;
  } | null;
  servFetch?: typeof fetch;
};

export async function executeScoutRun(input: {
  ownerId: string;
  body: StartScoutBody;
  kv: Kv | null;
  resume?: ScoutRunResult | null;
  signal?: AbortSignal | null;
  idempotencyKey?: string | null;
  /**
   * Integration/tests only. Production `POST /api/scout` never supplies this —
   * live spend stays blocked without a verified non-env authority.
   */
  harness?: ScoutRunHarness | null;
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
  // Defense: client cannot smuggle harness/testAuthority through body.
  const harness = input.harness ?? null;

  const req: SafeScoutRequest = {
    ownerId: input.ownerId,
    mandate: cleaned.mandate,
    planner: cleaned.planner ?? "offline_heuristic",
    preferLive: Boolean(cleaned.preferLive),
    resume: input.resume ?? null,
    channel: "api",
    idempotencyKey: input.idempotencyKey ?? null,
  };

  const env = harness?.env ?? process.env;
  const autodevKey = env.AUTODEV_API_KEY?.trim();
  const paidOn =
    env.SCOUT_PAID_EXECUTION?.trim().toLowerCase() === "1" ||
    env.SCOUT_PAID_EXECUTION?.trim().toLowerCase() === "true";

  const productionAutodev =
    paidOn && autodevKey ? { fetch, apiKey: autodevKey } : null;

  return executeScoutSafely({
    req,
    kv: input.kv,
    signal: input.signal,
    env,
    // Production: harness null → testAuthority null (env fake balances cannot open spend).
    testAuthority: harness?.testAuthority ?? null,
    autodevDeps: harness?.autodevDeps !== undefined ? harness.autodevDeps : productionAutodev,
    servFetch: harness?.servFetch,
  });
}
