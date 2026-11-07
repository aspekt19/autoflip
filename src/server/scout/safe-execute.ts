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
import { acquireScoutOwnerLock, releaseScoutOwnerLock } from "./concurrency";
import {
  authorizeLiveServPlanner,
  readPaidExecutionConfig,
  serverScoutBudgets,
  stripClientSpendClaims,
  type PaidSpendAuthority,
} from "./paid-execution";
import { resolveOwnerSpendAuthority } from "./owner-authority";
import { blockedServPlanner, servScoutPlanner } from "./planner";
import { resolveScoutInventory } from "./providers";
import {
  bindScoutIdempotencyRun,
  claimScoutIdempotency,
  completeScoutIdempotency,
} from "./idempotency";
import { saveScoutRun } from "./store";

export type SafeScoutRequest = {
  ownerId: string;
  /** SHA-256 of presenting af_ key (or grant-bound hash from signed session). */
  apiKeyHash?: string | null;
  grantId?: string | null;
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
  /**
   * Stubbed SERV transport for integration tests. Production omits (runServ default fetch).
   * Never accepted from client JSON.
   */
  servFetch?: typeof fetch;
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
      // Intent changes result meaning (live vs fixture; SERV vs heuristic) — bind the claim.
      // Client spend fields stay stripped from mandate and are never part of this intent.
      intent: {
        planner: input.req.planner ?? "offline_heuristic",
        preferLive: Boolean(input.req.preferLive),
      },
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
    if (claim.kind === "recovery_needed") {
      return {
        ok: false,
        status: 409,
        body: {
          error: "idempotency_recovery_needed",
          message: claim.reason,
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

  // Spend authority: test harness OR explicit Kv owner_grant bound to apiKeyHash.
  // Never from env balance / unsigned af_uid / allowlist alone.
  // Autodev inventory and SERV planner resolve separately (SERV-only grants allowed).
  let inventoryAuthority: PaidSpendAuthority | null = input.testAuthority ?? null;
  let servAuthority: PaidSpendAuthority | null = input.testAuthority ?? null;
  const preferLive = Boolean(input.req.preferLive);
  const plannerModeEarly = input.req.planner ?? "offline_heuristic";
  if (!input.testAuthority && input.req.apiKeyHash) {
    if (preferLive) {
      const resolved = await resolveOwnerSpendAuthority({
        kv: input.kv,
        ownerId: input.req.ownerId,
        apiKeyHash: input.req.apiKeyHash,
        grantId: input.req.grantId,
        provider: "autodev",
        env,
      });
      if (resolved.ok) inventoryAuthority = resolved.authority;
    }
    if (plannerModeEarly === "serv") {
      const resolved = await resolveOwnerSpendAuthority({
        kv: input.kv,
        ownerId: input.req.ownerId,
        apiKeyHash: input.req.apiKeyHash,
        grantId: input.req.grantId,
        provider: "serv",
        env,
      });
      if (resolved.ok) servAuthority = resolved.authority;
    }
  }
  const spendAuthority = inventoryAuthority ?? servAuthority;

  const lockToken =
    input.req.idempotencyKey?.trim() ||
    `lock-${input.req.ownerId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  // Distributed lock only when Kv is present (production/Upstash). kv:null test/eval skips.
  let lockHeld = false;
  if (input.kv) {
    const lock = await acquireScoutOwnerLock(input.kv, input.req.ownerId, lockToken);
    if (!lock.ok) {
      return {
        ok: false,
        status: lock.error === "lock_busy" ? 429 : 503,
        body: { error: lock.error, message: lock.message },
      };
    }
    lockHeld = true;
  }

  try {
    void spendAuthority;
    // Server-owned budgets only — clients cannot raise ceilings.
    // Clamp maxServCalls to SERV grant remaining so planner budgetsRemaining matches
    // real owner-grant spend (avoids showing 8 when grant only has 3).
    const budgets = serverScoutBudgets({
      maxProviderCalls: inventoryAuthority
        ? Math.max(0, inventoryAuthority.remainingProviderBudget)
        : servAuthority
          ? Math.max(0, servAuthority.remainingProviderBudget)
          : 0,
      maxServCalls: servAuthority
        ? Math.max(0, servAuthority.remainingProviderBudget)
        : undefined,
    });

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
      // Keep preferLive even without autodev wired — fail closed, never silent fixture.
      preferLive,
      env,
      maxProviderCalls: budgets.maxProviderCalls,
      signal: input.signal,
      testAuthority: inventoryAuthority,
    });

    const plannerMode = plannerModeEarly;
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
        testAuthority: servAuthority,
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
          testAuthority: servAuthority,
          config: readPaidExecutionConfig(env),
          env,
          fetch: input.servFetch,
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

    const persisted = input.kv ? await saveScoutRun(input.kv, result) : { ok: true as const };
    if (!persisted.ok) {
      if (idemRecordKey) {
        return {
          ok: false,
          status: 503,
          body: {
            error: "idempotency_persist_failure",
            message: `${persisted.message} Scout work may have run, but durable receipt was not acknowledged. Do not retry as free; no extra tool calls.`,
          },
        };
      }
      return {
        ok: false,
        status: 503,
        body: {
          error: "persist_failure",
          message: persisted.message,
        },
      };
    }

    const ok: SafeScoutOk = {
      ok: true,
      result,
      inventoryMode: inventory.mode,
      isFixture: inventory.isFixture,
      paidBlockedReason: inventory.paidBlockedReason,
    };

    if (idemRecordKey && mandateHash && input.kv) {
      await bindScoutIdempotencyRun(input.kv, idemRecordKey, {
        ownerId: input.req.ownerId,
        mandateHash,
        runId: result.runId,
        inventoryMode: inventory.mode,
        isFixture: inventory.isFixture,
        paidBlockedReason: inventory.paidBlockedReason,
      });
      try {
        await completeScoutIdempotency(input.kv, idemRecordKey, {
          ownerId: input.req.ownerId,
          mandateHash,
          result,
          inventoryMode: inventory.mode,
          isFixture: inventory.isFixture,
          paidBlockedReason: inventory.paidBlockedReason,
        });
      } catch {
        // Run + bind are durable; next claim reconciles receipt.
      }
    }

    return ok;
  } finally {
    if (lockHeld) {
      await releaseScoutOwnerLock(input.kv, input.req.ownerId, lockToken);
    }
  }
}
