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
  type PaidSpendAuthority,
} from "./paid-execution";
import { blockedServPlanner, servScoutPlanner } from "./planner";
import { resolveScoutInventory } from "./providers";
import {
  claimScoutIdempotency,
  completeScoutIdempotency,
} from "./idempotency";
import { saveScoutRun } from "./store";

export type SafeScoutRequest = {
  ownerId: string;
  mandate: unknown;
  preferLive?: boolean;
  planner?: "offline_heuristic" | "serv" | "mock_script";
  mockScript?: Parameters<typeof mockServPlanner>[0];
  resume?: ScoutRunResult | null;
  channel: "api" | "openserv_sdk" | "eval" | "test";
  /** Server-owned idempotency key (from Idempotency-Key header) — never client spend auth. */
  idempotencyKey?: string | null;
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
  idempotentReplay?: boolean;
};

export async function executeScoutSafely(input: {
  req: SafeScoutRequest;
  kv: Kv | null;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal | null;
  /**
   * Test-only paid authority. Production HTTP/SDK must omit — env cannot supply this.
   */
  testAuthority?: PaidSpendAuthority | null;
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

  if (input.signal?.aborted) {
    return {
      ok: false,
      status: 499,
      body: { error: "client_aborted", message: "Request aborted before scout dispatch." },
    };
  }

  const mandate =
    input.req.mandate && typeof input.req.mandate === "object"
      ? stripClientSpendClaims(input.req.mandate as Record<string, unknown>)
      : input.req.mandate;

  // Claim BEFORE any scout/provider work. Missing Idempotency-Key → new run (not labeled idempotent).
  const idem = input.req.idempotencyKey?.trim() || null;
  let idemRecordKey: string | null = null;
  let mandateHash: string | null = null;
  if (idem) {
    if (!input.kv) {
      return {
        ok: false,
        status: 503,
        body: {
          error: "idempotency_store_required",
          message:
            "Idempotency-Key requires a durable Kv claim store. Missing key is allowed for non-idempotent runs.",
        },
      };
    }
    const claim = await claimScoutIdempotency({
      kv: input.kv,
      ownerId: input.req.ownerId,
      clientKey: idem,
      mandate,
      env,
    });
    if (claim.kind === "replay") {
      return {
        ok: true,
        result: claim.receipt.result,
        inventoryMode: claim.receipt.inventoryMode,
        isFixture: claim.receipt.isFixture,
        paidBlockedReason: claim.receipt.paidBlockedReason,
        idempotentReplay: true,
      };
    }
    if (claim.kind === "in_progress") {
      return {
        ok: false,
        status: 409,
        body: {
          error: "idempotency_in_progress",
          message:
            "Same Idempotency-Key is already in progress. Do not retry expensive work as free — wait or reuse the durable receipt when completed.",
          mandateHash: claim.mandateHash,
        },
      };
    }
    if (claim.kind === "conflict") {
      return {
        ok: false,
        status: 409,
        body: {
          error: "idempotency_conflict",
          message:
            "Idempotency-Key was claimed with a different mandate body. Use a new key for a different request.",
          existingHash: claim.existingHash,
          requestedHash: claim.requestedHash,
        },
      };
    }
    if (claim.kind === "backend_required") {
      return {
        ok: false,
        status: 503,
        body: {
          error: "idempotency_backend_required",
          message: claim.message,
        },
      };
    }
    idemRecordKey = claim.recordKey;
    mandateHash = claim.mandateHash;
  }

  // Server-owned budgets only — clients cannot raise maxProviderCalls/wall/serv ceilings.
  // Live provider budget stays 0 until a non-env authority exists AND is passed (tests only today).
  const budgets = serverScoutBudgets({
    maxProviderCalls: input.testAuthority ? Math.max(0, input.testAuthority.remainingProviderBudget) : 0,
  });

  const preferLive = Boolean(input.req.preferLive);
  const autodev =
    preferLive && input.autodevDeps?.apiKey
      ? {
          fetch: input.autodevDeps.fetch,
          apiKey: input.autodevDeps.apiKey,
          cache: input.autodevDeps.cache ?? new TtlCache<unknown>(),
          counter: input.autodevDeps.counter ?? new MemoryCounter(),
          source: "autodev" as const,
          signal: input.signal,
        }
      : null;

  const inventory = resolveScoutInventory({
    kv: input.kv,
    autodev,
    preferLive: preferLive && Boolean(autodev),
    env,
    maxProviderCalls: budgets.maxProviderCalls,
    signal: input.signal,
    // Never read testAuthority from env — only explicit code arg (unit tests).
    testAuthority: input.testAuthority ?? null,
  });

  const plannerMode = input.req.planner ?? "offline_heuristic";
  let planner;
  let autonomyClaim: "serv_directed" | "none" = "none";

  if (plannerMode === "mock_script") {
    autonomyClaim = "none";
    planner = input.req.mockScript
      ? mockServPlanner(input.req.mockScript)
      : refusingPlanner("serv_unavailable");
  } else if (plannerMode === "serv") {
    const paid = authorizeLiveServPlanner({
      config: readPaidExecutionConfig(env),
      kv: input.kv,
      testAuthority: input.testAuthority ?? null,
    });
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
        kv: input.kv,
        testAuthority: input.testAuthority ?? null,
      });
    }
  } else {
    planner = heuristicOfflinePlanner();
  }

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

  const ok: SafeScoutOk = {
    ok: true,
    result,
    inventoryMode: inventory.mode,
    isFixture: inventory.isFixture,
    paidBlockedReason: inventory.paidBlockedReason,
  };

  // Durable completed receipt — overwrites in_progress. Never TTL (≠ credit-lock).
  if (idemRecordKey && mandateHash && input.kv) {
    await completeScoutIdempotency(input.kv, idemRecordKey, {
      ownerId: input.req.ownerId,
      mandateHash,
      result,
      inventoryMode: inventory.mode,
      isFixture: inventory.isFixture,
      paidBlockedReason: inventory.paidBlockedReason,
    });
  }

  return ok;
}
