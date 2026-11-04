import { randomUUID } from "node:crypto";
import { ASSUMPTIONS } from "@/domain/assumptions";
import {
  formatFilterBreakdown,
  groupByCriteria,
  hardReject,
  intervalHours,
  isDue,
  marketBand,
  mergeSeen,
  prefilterListing,
  rankPasses,
  seenStorageKey,
  tallyReason,
  toListingsQuery,
  unseenListings,
  type SavedSearch,
  type WatchAlert,
} from "@/domain/radar-watch";
import { auditExplanation } from "@/domain/audit";
import { listingsSearchUrl } from "@/io/autodev";
import type { Kv } from "@/io/kv";
import { storageMode } from "@/io/kv";
import { payRadarTicket } from "@/io/kite-pay";
import { parseAutoDevListings } from "@/io/parsers";
import { reserveRadarCall } from "@/io/persistent-quota";
import { buildAlertReviewRequest, buildGuardRequest, interpretGuard, postServ } from "@/io/serv";
import { alertMessage } from "@/io/telegram";
import type { ComputedReport, Listing } from "@/domain/types";
import { syncPresetSearches } from "@/domain/demo-presets";
import { listSearches, upsertRun, saveAlerts, saveSearches, seenVins, storeSeen, telegramChat, type StoredRun, listAlerts } from "./radar-store";

/** Stay under the 60s Hobby limit so the log write still happens. */
export const CYCLE_BUDGET_MS = 40_000;

const CALL_MS = {
  autodev: 8_000,
  serv: 8_000,
  telegram: 5_000,
  kite: 8_000,
};

export type CycleDeps = {
  kv: Kv;
  now: Date;
  trigger: "cron" | "check_now";
  fetchImpl: typeof fetch;
  autodevKey?: string;
  servKey?: string;
  servModel?: string;
  servBaseUrl?: string;
  origin: string;
  env: Record<string, string | undefined>;
  forceAll?: boolean;
  deadlineMs?: number;
  timeouts?: Partial<typeof CALL_MS>;
};

type Step = StoredRun["steps"][number];

export async function runRadarCycle(deps: CycleDeps): Promise<StoredRun> {
  const startedAt = deps.now.toISOString();
  const startedWall = Date.now();
  const budget = deps.deadlineMs ?? CYCLE_BUDGET_MS;
  const remain = () => budget - (Date.now() - startedWall);
  const limits = { ...CALL_MS, ...deps.timeouts };
  const notes: string[] = [];
  const steps: Step[] = [];
  const runId = randomUUID();
  let listings = 0;
  let passed = 0;
  let filteredOut = 0;
  let alertsSent = 0;
  let autodevCalls = 0;
  let skippedDue = 0;
  let filterBreakdown = "";
  let hours = 3;
  let uniqueSearches = 0;
  let promptGuard = "not_started";
  let shadow = "not_started";
  let payment: StoredRun["payment"] = {
    status: "not_configured",
    missing: [],
    tx: null,
    detail: "Payment step did not run.",
    costAtomic: null,
    network: null,
  };

  const snapshot = () =>
    finish(
      deps,
      runId,
      startedAt,
      hours,
      uniqueSearches,
      listings,
      passed,
      filteredOut,
      filterBreakdown,
      alertsSent,
      autodevCalls,
      skippedDue,
      notes,
      steps,
      promptGuard,
      shadow,
      payment,
    );

  try {
    const synced = syncPresetSearches(await listSearches(deps.kv), deps.now.toISOString());
    if (synced.changed) await saveSearches(deps.kv, synced.searches);
    const searches = synced.searches.filter((item) => item.enabled);
    const groups = groupByCriteria(searches);
    uniqueSearches = groups.size;
    hours = intervalHours(groups.size || 1);
    const intervalMs = hours * 60 * 60 * 1000;
    const alerts = await listAlerts(deps.kv);
    const freshAlerts: WatchAlert[] = [];

    promptGuard = await runGuard(searches, deps, Math.min(limits.serv, remain()));
    steps.push({ id: "serv_prompt_guard", status: promptGuard });
    notes.push(`prompt guard: ${promptGuard}`);
    if (promptGuard === "block") {
      notes.push("Saved criteria were rejected by the input check. No listings call was made.");
      shadow = "not_run";
      const run = snapshot();
      await upsertRun(deps.kv, run);
      return run;
    }

    if (!deps.autodevKey) notes.push("AUTODEV_API_KEY is not set. No listings were requested and no alerts were invented.");

    const due: { key: string; group: SavedSearch[] }[] = [];
    for (const [key, group] of groups) {
      const ready = deps.forceAll || group.some((item) => isDue(item.lastCheckedAt, deps.now.getTime(), intervalMs));
      if (!ready) {
        skippedDue += group.length;
        continue;
      }
      if (!deps.autodevKey) {
        stamp(group, deps.now.toISOString());
        continue;
      }
      if (remain() < 1_500) {
        notes.push("Stopped before another listings call so this run can be saved.");
        steps.push({ id: "listings", status: "partial", detail: "deadline" });
        break;
      }
      const slot = await reserveRadarCall(deps.kv, deps.now);
      if (!slot.ok) {
        notes.push(slot.message);
        steps.push({ id: "listings", status: "budget", detail: slot.message });
        break;
      }
      autodevCalls += 1;
      due.push({ key, group });
    }

    const fetched = await Promise.all(
      due.map(async (job) => {
        const url = listingsSearchUrl(toListingsQuery(job.group[0]!.criteria));
        const result = await fetchListings(url, deps.autodevKey!, deps.fetchImpl, Math.min(limits.autodev, remain()));
        if (!result.ok) return { ...job, listings: null as Listing[] | null, error: result.message };
        return { ...job, listings: result.listings, error: undefined as string | undefined };
      }),
    );

    const reasons = new Map<string, number>();
    let listingTimeouts = 0;
    for (const job of fetched) {
      if (!job.listings) {
        notes.push(job.error ?? "Listings call failed.");
        if (job.error === "timeout") listingTimeouts += 1;
        stamp(job.group, deps.now.toISOString());
        continue;
      }
      listings += job.listings.length;
      const criteria = job.group[0]!.criteria;
      const eligible = job.listings.filter((listing) => hardReject(listing, criteria) === null);
      const band = marketBand(eligible);
      for (const search of job.group) {
        const storageKey = seenStorageKey(search.id, search.criteria);
        const seen = await seenVins(deps.kv, storageKey);
        const fresh = unseenListings(job.listings, seen);
        tallyReason(reasons, "already seen", job.listings.length - fresh.length);
        const decisions = fresh.map((listing) => ({
          listing,
          decision: prefilterListing(listing, search.criteria, band, search.mode, deps.now.getUTCFullYear()),
        }));
        const passedRows = decisions.filter((item) => item.decision.pass);
        for (const item of decisions) {
          if (!item.decision.pass) tallyReason(reasons, item.decision.reason);
        }
        const winners = rankPasses(
          passedRows.flatMap((item) =>
            item.decision.pass ? [{ listing: item.listing, numbers: item.decision.numbers, why: item.decision.why }] : [],
          ),
        ).slice(0, ASSUMPTIONS.radarMaxAlertsPerSearch);
        const winnerVins = new Set(winners.map((winner) => winner.listing.vin));
        tallyReason(reasons, "past the alert cap", passedRows.filter((item) => !winnerVins.has(item.listing.vin)).length);
        filteredOut += decisions.length - passedRows.length;
        passed += passedRows.length;
        await storeSeen(
          deps.kv,
          storageKey,
          mergeSeen(
            seen,
            passedRows.map((item) => item.listing.vin),
          ),
        );
        for (const winner of winners) {
          const alert = makeAlert(search, winner.listing, winner.why, winner.numbers, deps.now.toISOString());
          alerts.unshift(alert);
          freshAlerts.push(alert);
          alertsSent += 1;
        }
        search.lastCheckedAt = deps.now.toISOString();
      }
    }
    filterBreakdown = formatFilterBreakdown(reasons);
    steps.push({
      id: "listings",
      status: listingTimeouts > 0 ? "timeout" : "ok",
      detail: `${listings} rows, ${autodevCalls} calls`,
    });

    await saveSearches(deps.kv, await mergeChecked(deps.kv, searches));
    await saveAlerts(deps.kv, alerts);
    shadow = deps.servKey ? "pending" : "not_configured";
    await upsertRun(deps.kv, snapshot());

    if (!deps.servKey) {
      shadow = "not_configured";
      steps.push({ id: "serv_shadow_agent", status: "not_configured" });
    } else if (freshAlerts.length === 0) {
      shadow = "no_alerts";
      steps.push({ id: "serv_shadow_agent", status: "no_alerts" });
    } else if (remain() < 500) {
      shadow = "timeout";
      notes.push("Shadow check skipped. Alerts kept the deterministic text.");
      steps.push({ id: "serv_shadow_agent", status: "timeout", detail: "no time left" });
    } else {
      const reviews = await Promise.all(
        freshAlerts.map(async (alert) => {
          try {
            return await withTimeout(
              reviewWhy(alert.why, alert.numbers, deps, Math.min(limits.serv, remain())),
              Math.min(limits.serv, remain()),
            );
          } catch {
            return { why: alert.why, source: "timeout" };
          }
        }),
      );
      reviews.forEach((review, index) => {
        freshAlerts[index]!.why = review.why;
      });
      shadow = summarizeShadow(reviews.map((review) => review.source));
      const timedOut = reviews.some((review) => review.source === "timeout");
      steps.push({ id: "serv_shadow_agent", status: timedOut ? "timeout" : "ok", detail: shadow });
      await saveAlerts(deps.kv, alerts);
    }

    const chats = new Map<string, string | null>();
    await Promise.all(
      [...new Set(freshAlerts.map((alert) => alert.ownerId))].map(async (ownerId) => {
        chats.set(ownerId, await telegramChat(deps.kv, ownerId));
      }),
    );
    if (!deps.env.TELEGRAM_BOT_TOKEN) {
      notes.push("Telegram is not configured. Alerts stay in the app.");
      steps.push({ id: "telegram", status: "not_configured" });
    } else {
      const sends = freshAlerts.filter((alert) => chats.get(alert.ownerId));
      const outcomes = await Promise.all(sends.map((alert) => sendTelegram(chats.get(alert.ownerId)!, alert, deps, Math.min(limits.telegram, remain()))));
      const telegramStatus = outcomes.some((item) => item === "timeout") ? "timeout" : "ok";
      steps.push({ id: "telegram", status: sends.length === 0 ? "no_chat" : telegramStatus });
    }

    try {
      payment = await withTimeout(
        payRadarTicket({ ticketUrl: `${deps.origin}/api/v1/radar-ticket`, env: deps.env, fetchImpl: deps.fetchImpl }),
        Math.min(limits.kite, remain()),
      );
    } catch {
      payment = { ...payment, status: "failed", detail: "Payment step timed out. No transaction was recorded." };
    }
    steps.push({ id: "payment", status: payment.status, detail: payment.detail });

    const run = snapshot();
    await upsertRun(deps.kv, run);
    return run;
  } catch (error) {
    notes.push(error instanceof Error ? error.message : "The cycle stopped.");
    steps.push({ id: "cycle", status: "error", detail: notes[notes.length - 1] });
    const run = snapshot();
    await upsertRun(deps.kv, run).catch(() => undefined);
    return run;
  }
}

function stamp(group: SavedSearch[], iso: string) {
  for (const search of group) search.lastCheckedAt = iso;
}

async function mergeChecked(kv: Kv, updated: SavedSearch[]): Promise<SavedSearch[]> {
  const all = await listSearches(kv);
  const byId = new Map(updated.map((item) => [item.id, item]));
  return all.map((item) => byId.get(item.id) ?? item);
}

function finish(
  deps: CycleDeps,
  id: string,
  startedAt: string,
  hours: number,
  uniqueSearches: number,
  listings: number,
  passed: number,
  filteredOut: number,
  filterBreakdown: string,
  alertsSent: number,
  autodevCalls: number,
  skippedDue: number,
  notes: string[],
  steps: Step[],
  promptGuard: string,
  shadow: string,
  payment: StoredRun["payment"],
): StoredRun {
  return {
    id,
    startedAt,
    finishedAt: new Date().toISOString(),
    trigger: deps.trigger,
    storage: storageMode(deps.env),
    uniqueSearches,
    intervalHours: hours,
    listings,
    passed,
    filteredOut,
    filterBreakdown,
    alertsSent,
    autodevCalls,
    skippedDue,
    notes,
    steps,
    serv: { promptGuard, shadow },
    payment,
  };
}

async function runGuard(searches: SavedSearch[], deps: CycleDeps, timeoutMs: number): Promise<string> {
  if (!deps.servKey) return "not_configured";
  const text = searches.map((item) => `${item.name} ${item.mode} ${item.criteria.zip} ${item.criteria.priceMax}`).join("\n");
  if (!text.trim()) return "skipped_empty";
  if (timeoutMs <= 0) return "timeout";
  try {
    const result = await withTimeout(
      postServ(buildGuardRequest(text, deps.servModel || "gpt-5.4-mini"), {
        fetch: deps.fetchImpl,
        apiKey: deps.servKey,
        baseUrl: deps.servBaseUrl || "https://inference-api.openserv.ai/v1",
        timeoutMs,
      }),
      timeoutMs,
    );
    if (!result.ok) return result.error === "SERV did not respond." ? "timeout" : `error: ${result.error}`;
    return interpretGuard(result.text);
  } catch {
    return "timeout";
  }
}

async function reviewWhy(
  why: string,
  numbers: WatchAlert["numbers"],
  deps: CycleDeps,
  timeoutMs: number,
): Promise<{ why: string; source: string }> {
  if (!deps.servKey) return { why, source: "template" };
  if (timeoutMs <= 0) return { why, source: "timeout" };
  const result = await postServ(buildAlertReviewRequest(why, numbers, deps.servModel || "gpt-5.4-mini"), {
    fetch: deps.fetchImpl,
    apiKey: deps.servKey,
    baseUrl: deps.servBaseUrl || "https://inference-api.openserv.ai/v1",
    timeoutMs,
  });
  if (!result.ok) return { why, source: result.error === "SERV did not respond." ? "timeout" : "template_after_error" };
  const audit = auditExplanation(result.text, fakeReport(numbers, why));
  const failed = result.shadowOutcome === "exhausted" || result.shadowOutcome === "failed";
  if (!audit.ok || failed) return { why, source: failed ? "shadow_rejected" : "audit_rejected" };
  return { why: result.text, source: result.shadowOutcome };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new Error("timed out"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function fakeReport(numbers: WatchAlert["numbers"], why: string): ComputedReport {
  return {
    mode: "personal",
    subject: {
      vin: "00000000000000000",
      year: 2016,
      make: "Toyota",
      model: "RAV4",
      trim: null,
      miles: numbers.miles,
      priceUsd: numbers.priceUsd,
      city: null,
      state: null,
      zip: null,
      dealer: null,
      vdp: null,
      primaryImage: null,
      carfaxUrl: null,
      used: true,
      cpo: false,
      accidentCount: null,
      oneOwner: null,
      ownerCount: null,
      usageType: null,
      fuel: null,
      engine: null,
      drivetrain: null,
      bodyStyle: null,
      latitude: null,
      longitude: null,
      removedAt: null,
      source: "autodev",
    },
    verdict: "fair",
    score: null,
    reasons: [why],
    flags: [],
    questions: [],
    comps: [],
    compScope: "year_window",
    percentile: null,
    fairValueUsd: numbers.medianUsd,
    priceGap: numbers.medianUsd ? (numbers.priceUsd - numbers.medianUsd) / numbers.medianUsd : null,
    mileage: { expectedMiles: numbers.expectedMiles, subjectMiles: numbers.miles, medianCompMiles: null, perMileUsd: null },
    history: { multiplier: 1, lines: [] },
    recalls: [],
    openParkIt: false,
    complaintCount: null,
    fuel: null,
    vinDecode: null,
    distanceToSearchZipMiles: null,
    flip: numbers.roughMarginUsd === null
      ? null
      : {
          resaleLowUsd: numbers.lowUsd,
          resaleMidUsd: numbers.medianUsd,
          resaleHighUsd: numbers.highUsd,
          titleFeeUsd: 350,
          reconUsd: 600,
          sellFriction: 0.03,
          allInUsd: numbers.priceUsd,
          conservativeProceedsUsd: numbers.medianUsd,
          marginUsd: numbers.roughMarginUsd,
          targetBuyUsd: 0,
          timeToSellRisk: "medium",
          timeToSellNote: "",
        },
    assumptions: {
      milesPerYear: 12000,
      flipTitleFeeUsd: 350,
      flipReconBaseUsd: 600,
      flipDesiredProfitUsd: 1500,
      flipSellFriction: 0.03,
      goodDealGap: -0.08,
      fairGap: 0.06,
      overpricedGap: 0.15,
      accidentHaircutEach: 0.04,
      accidentHaircutCap: 0.12,
      fleetHaircut: 0.06,
      multiOwnerHaircut: 0.03,
      oneOwnerBonus: 0.015,
      cpoBonusPersonal: 0.02,
      mileageRatePerThousandMiles: 0.005,
    },
    dataNotes: [],
    sample: false,
  };
}

function makeAlert(search: SavedSearch, listing: Listing, why: string, numbers: WatchAlert["numbers"], iso: string): WatchAlert {
  return {
    id: randomUUID(),
    ownerId: search.ownerId,
    searchId: search.id,
    vin: listing.vin,
    createdAt: iso,
    status: "new",
    mode: search.mode,
    year: listing.year,
    make: listing.make,
    model: listing.model,
    trim: listing.trim,
    priceUsd: listing.priceUsd ?? numbers.priceUsd,
    miles: listing.miles,
    city: listing.city,
    state: listing.state,
    why,
    numbers,
    sample: listing.source === "sample",
  };
}

async function fetchListings(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: true; listings: Listing[] } | { ok: false; message: string }> {
  if (timeoutMs <= 0) return { ok: false, message: "timeout" };
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, message: `Listings provider returned ${response.status}.` };
    const json = await withTimeout(response.json() as Promise<unknown>, timeoutMs);
    return { ok: true, listings: parseAutoDevListings(json, "autodev") };
  } catch {
    return { ok: false, message: "timeout" };
  }
}

async function sendTelegram(chatId: string, alert: WatchAlert, deps: CycleDeps, timeoutMs: number): Promise<"ok" | "timeout" | "skipped"> {
  const token = deps.env.TELEGRAM_BOT_TOKEN;
  if (!token || timeoutMs <= 0) return "skipped";
  const message = alertMessage({ why: alert.why, origin: deps.origin, alertId: alert.id });
  try {
    await withTimeout(
      deps.fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message.text, reply_markup: message.reply_markup }),
        signal: AbortSignal.timeout(timeoutMs),
      }),
      timeoutMs,
    );
    return "ok";
  } catch {
    return "timeout";
  }
}

function summarizeShadow(notes: string[]): string {
  if (notes.length === 0) return "no_alerts";
  const counts = new Map<string, number>();
  for (const note of notes) counts.set(note, (counts.get(note) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => `${name}:${count}`).join(", ");
}
