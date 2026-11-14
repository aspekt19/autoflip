/**
 * Agent Deal Radar — saved searches / check-now / feed for the key owner's account.
 * Same plan gates as the site (/radar): Radar $100 or Radar Pro $250 (Stripe TEST).
 */
import { randomUUID } from "node:crypto";
import { productFlagsUnavailableMessage, resolveProductFlags } from "@/domain/product-flags";
import type { WatchCriteria } from "@/domain/radar-watch";
import { parseDistanceMiles } from "@/domain/need";
import type { Kv } from "@/io/kv";
import { allowance } from "@/server/plan-book";
import { normalizeCriteria } from "@/server/radar-normalize-criteria";
import { runRadarCycle } from "@/server/radar-cycle";
import { listAlerts, listSearches, saveSearches } from "@/server/radar-store";
import type { AgentCaller } from "./agent-auth";
import { agentError, type AgentErrorEnvelope } from "./agent-envelope";
import { readRadarTestModeState } from "./radar-test-mode";

export type AgentRadarDeps = {
  kv: Kv;
  origin: string;
  servKey?: string;
  servBaseUrl?: string;
  servModel?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  env?: Record<string, string | undefined>;
};

function radarUnavailable(origin: string): AgentErrorEnvelope {
  return agentError({
    error_code: "radar_unavailable",
    message: productFlagsUnavailableMessage("dealRadar"),
    next_steps: {
      action: "use_site_or_resale",
      summary: "Deal Radar watches are not available in this preview.",
      request: { method: "GET", url: `${origin}/resale` },
      docs: `${origin}/developers`,
    },
  });
}

export async function agentListRadarWatches(caller: AgentCaller, deps: AgentRadarDeps) {
  if (!resolveProductFlags().dealRadar) {
    return { ok: false as const, status: 404, body: radarUnavailable(deps.origin) };
  }
  const testMode = await readRadarTestModeState(deps.kv);
  const searches = (await listSearches(deps.kv)).filter((row) => row.ownerId === caller.userId);
  const alerts = (await listAlerts(deps.kv)).filter((row) =>
    searches.some((search) => search.id === row.searchId),
  );
  return {
    ok: true as const,
    body: {
      watches: searches.map((row) => ({
        id: row.id,
        name: row.name,
        mode: row.mode,
        enabled: row.enabled,
        criteria: row.criteria,
        lastCheckedAt: row.lastCheckedAt ?? null,
        pauseReason: row.pauseReason ?? null,
      })),
      alertCount: alerts.filter((row) => row.status === "new" || row.status === "opened").length,
      trialStopped: testMode.stopped,
      trialStopMessage: testMode.message,
      credit_spent: false,
    },
  };
}

export async function agentSaveRadarWatch(
  caller: AgentCaller,
  input: {
    name?: string;
    mode?: string;
    criteria?: WatchCriteria & { nationwide?: boolean };
  },
  deps: AgentRadarDeps,
) {
  if (!resolveProductFlags().dealRadar) {
    return { ok: false as const, status: 404, body: radarUnavailable(deps.origin) };
  }
  const testMode = await readRadarTestModeState(deps.kv);
  if (testMode.stopped) {
    return { ok: false as const, status: 423, body: agentError({
      error_code: "radar_test_complete",
      message: testMode.message ?? "Deal Radar is paused after its first test notification.",
      next_steps: { action: "read_existing_alerts", summary: "The test notification is saved. No further Radar watches can be activated." },
    }) };
  }
  const criteria = input.criteria;
  const mode = input.mode === "flip" ? "flip" : "personal";
  if (!criteria || !criteria.priceMax) {
    return {
      ok: false as const,
      status: 400,
      body: agentError({
        error_code: "invalid_criteria",
        message: "A saved search needs a maximum price (criteria.priceMax).",
        next_steps: {
          action: "provide_criteria",
          summary: "Send mode + criteria.priceMax (and ZIP for personal / radius Flip).",
          request: {
            method: "POST",
            url: `${deps.origin}/api/v1/radar/watches`,
            body: {
              name: "Flip under 12k",
              mode: "flip",
              criteria: { priceMax: 12_000, zip: "78701", radiusMiles: 100 },
            },
          },
          docs: `${deps.origin}/developers`,
        },
      }),
    };
  }

  const wantsNationwide =
    mode === "flip" &&
    (criteria.nationwide === true ||
      criteria.radiusMiles == null ||
      (typeof criteria.radiusMiles === "number" && !Number.isFinite(criteria.radiusMiles)));

  if (mode === "personal" && !criteria.zip) {
    return {
      ok: false as const,
      status: 400,
      body: agentError({
        error_code: "invalid_criteria",
        message: "A personal saved search needs a ZIP and a maximum price.",
        next_steps: {
          action: "provide_zip",
          summary: "Add criteria.zip.",
          request: {
            method: "POST",
            url: `${deps.origin}/api/v1/radar/watches`,
            body: { mode: "personal", criteria: { zip: "78701", priceMax: 15_000, radiusMiles: 50 } },
          },
        },
      }),
    };
  }

  let radiusMiles: number | null = null;
  if (!wantsNationwide) {
    if (!criteria.zip) {
      return {
        ok: false as const,
        status: 400,
        body: agentError({
          error_code: "invalid_criteria",
          message: "A Flip watch with a radius needs a ZIP (or leave radius empty for nationwide).",
          next_steps: {
            action: "provide_zip_or_nationwide",
            summary: "Add criteria.zip with radiusMiles, or omit radius for nationwide Flip.",
            request: {
              method: "POST",
              url: `${deps.origin}/api/v1/radar/watches`,
              body: { mode: "flip", criteria: { priceMax: criteria.priceMax, zip: "78701", radiusMiles: 100 } },
            },
          },
        }),
      };
    }
    const radiusParsed = parseDistanceMiles(criteria.radiusMiles);
    if (!radiusParsed.ok || radiusParsed.miles == null) {
      return {
        ok: false as const,
        status: 400,
        body: agentError({
          error_code: "invalid_radius",
          message: radiusParsed.ok
            ? "Flip watches need a seller-distance radius, or leave radius empty for nationwide."
            : radiusParsed.message,
          next_steps: {
            action: "fix_radius",
            summary: "Set criteria.radiusMiles (1–500) or leave it empty for nationwide Flip.",
            request: {
              method: "POST",
              url: `${deps.origin}/api/v1/radar/watches`,
              body: { mode: "flip", criteria: { priceMax: criteria.priceMax, zip: criteria.zip, radiusMiles: 100 } },
            },
          },
        }),
      };
    }
    radiusMiles = radiusParsed.miles;
  } else if (!criteria.zip) {
    criteria.zip = "";
  }

  const searches = await listSearches(deps.kv);
  if (searches.some((item) => item.enabled)) {
    return {
      ok: false as const,
      status: 423,
      body: agentError({
        error_code: "radar_test_watch_limit",
        message: "The current test allows one active Deal Radar watch across the entire project.",
        next_steps: { action: "read_existing_watches", summary: "Pause or remove the existing watch before creating another." },
      }),
    };
  }
  const mine = searches.filter((item) => item.ownerId === caller.userId);
  const totalEnabled = mine.filter((item) => item.enabled).length;
  const allowed = await allowance(deps.kv, caller.userId, totalEnabled);
  if (!allowed.ok) {
    return {
      ok: false as const,
      status: 402,
      body: agentError({
        error_code: allowed.code === "plan_required" ? "plan_required" : "plan_limit",
        message: allowed.message,
        next_steps: {
          action: "subscribe_radar_plan",
          summary: "Saved Deal Radar watches need Radar ($100/mo) or Radar Pro ($250/mo) on Stripe TEST.",
          request: { method: "GET", url: `${deps.origin}/pricing?from=watch` },
          docs: `${deps.origin}/pricing`,
        },
      }),
    };
  }
  if (mine.length >= allowed.limits.watchLimit) {
    return {
      ok: false as const,
      status: 403,
      body: agentError({
        error_code: "plan_limit",
        message: `This plan can save up to ${allowed.limits.watchLimit} watched searches.`,
        next_steps: {
          action: "upgrade_or_remove",
          summary: "Remove a watch or upgrade to Radar Pro.",
          request: { method: "GET", url: `${deps.origin}/pricing` },
        },
      }),
    };
  }

  const watch = {
    id: randomUUID(),
    ownerId: caller.userId,
    name: (input.name?.trim() || `${mode === "flip" ? "Resale" : "Find"} watch`).slice(0, 80),
    mode: mode as "personal" | "flip",
    enabled: true,
    criteria: normalizeCriteria(criteria, mode, radiusMiles),
    createdAt: new Date().toISOString(),
    preset: false,
    lastCheckedAt: null as string | null,
    pauseReason: null as "requires_plan" | null,
  };
  searches.push(watch);
  await saveSearches(deps.kv, searches);
  return {
    ok: true as const,
    body: { watch, credit_spent: false, plan: allowed.limits },
  };
}

export async function agentRadarCheckNow(caller: AgentCaller, deps: AgentRadarDeps) {
  if (!resolveProductFlags().dealRadar) {
    return { ok: false as const, status: 404, body: radarUnavailable(deps.origin) };
  }
  const testMode = await readRadarTestModeState(deps.kv);
  if (testMode.stopped) {
    return { ok: true as const, body: {
      runId: null, notes: [testMode.message ?? "Deal Radar is paused after its first test notification."],
      alertsSent: 0, credit_spent: false, journal: null, proofRecords: [],
      summary: "Deal Radar monitoring is stopped for the one-notification test.",
      trialStopped: true,
    } };
  }
  const mine = (await listSearches(deps.kv)).filter(
    (item) => item.ownerId === caller.userId && item.enabled,
  );
  if (mine.length === 0) {
    return {
      ok: true as const,
      body: {
        runId: null,
        notes: ["Save a search before checking."],
        alertsSent: 0,
        credit_spent: false,
        journal: null,
        proofRecords: [],
        summary: "No enabled watches for this API key owner.",
      },
    };
  }
  const run = await runRadarCycle({
    kv: deps.kv,
    now: deps.now ?? new Date(),
    trigger: "check_now",
    maxEnabledWatches: 1,
    forceAll: true,
    fetchImpl: deps.fetchImpl ?? fetch,
    autodevKey: (deps.env ?? process.env).AUTODEV_API_KEY?.trim(),
    servKey: deps.servKey ?? (deps.env ?? process.env).SERV_API_KEY?.trim(),
    servModel: deps.servModel ?? (deps.env ?? process.env).SERV_MODEL,
    servBaseUrl: deps.servBaseUrl ?? (deps.env ?? process.env).SERV_BASE_URL,
    origin: deps.origin,
    env: deps.env ?? process.env,
  });
  const mySearchIds = new Set(mine.map((item) => item.id));
  const ownerServActivity = (run.servActivity ?? []).filter((row) => mySearchIds.has(row.searchId));
  const alertsSent = ownerServActivity.filter((row) => row.alerted || row.decision === "alert").length;
  return {
    ok: true as const,
    body: {
      runId: run.id,
      notes: run.notes,
      alertsSent,
      credit_spent: false,
      journal: run.decisionJournal ?? null,
      proofRecords: run.proofRecords ?? [],
      servActivity: ownerServActivity,
      summary:
        "Deal Radar re-check finished for your saved searches (same SERV plan/decide path as the site).",
    },
  };
}

export async function agentRadarFeed(caller: AgentCaller, deps: AgentRadarDeps) {
  if (!resolveProductFlags().dealRadar) {
    return { ok: false as const, status: 404, body: radarUnavailable(deps.origin) };
  }
  const searches = (await listSearches(deps.kv)).filter((row) => row.ownerId === caller.userId);
  const ids = new Set(searches.map((row) => row.id));
  const alerts = (await listAlerts(deps.kv)).filter((row) => ids.has(row.searchId));
  return {
    ok: true as const,
    body: {
      watches: searches.length,
      alerts: alerts.slice(0, 40).map((row) => ({
        id: row.id,
        searchId: row.searchId,
        vin: row.vin,
        status: row.status,
        why: row.why,
        createdAt: row.createdAt,
        numbers: row.numbers ?? null,
      })),
      credit_spent: false,
    },
  };
}
