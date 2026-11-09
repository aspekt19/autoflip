import { randomUUID } from "node:crypto";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { priceBadge } from "@/domain/price-badge";
import {
  formatFilterBreakdown,
  groupByCriteria,
  hardReject,
  intervalHours,
  isDue,
  prefilterListing,
  rankPasses,
  seenStorageKey,
  tallyReason,
  type SavedSearch,
  type WatchAlert,
} from "@/domain/radar-watch";
import { topFlipCandidates, flipAlertWhy } from "@/domain/flip-rank";
import { isBroadFlip, isPriceDrop, listingQueries, matchesWatchModels } from "@/domain/watch-queries";
import { listingsSearchUrl } from "@/io/autodev";
import type { Kv } from "@/io/kv";
import { storageMode } from "@/io/kv";
import { payRadarTicket } from "@/io/kite-pay";
import { parseAutoDevListings } from "@/io/parsers";
import { reserveRadarCall } from "@/io/persistent-quota";
import { coverageConfidence, coverageSentence } from "@/domain/coverage";
import { quotedNumbersStayIn, visibleProof, type DecisionProof } from "@/domain/decision-note";
import { interpretGuard, runServ, servBudget, type ProfileId, type ServProof } from "@/server/serv";
import { alertMessage, type AlertCopy } from "@/io/telegram";
import type { Listing } from "@/domain/types";
import { syncPresetSearches } from "@/domain/demo-presets";
import { listSearches, upsertRun, saveAlerts, saveSearches, seenBook, storeSeenPrices, readListingCache, writeListingCache, telegramChat, telegramPaused, type StoredRun, listAlerts } from "./radar-store";

/** Stay under the 60s Hobby limit so the log write still happens. */
export const CYCLE_BUDGET_MS = 40_000;

const CALL_MS = {
  autodev: 8_000,
  /** Ceiling for one SERV request. Personal reviews use a shorter profile timeout. */
  serv: 25_000,
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
  const servChecks: ServProof[] = [];
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
      servChecks,
      payment,
    );

  try {
    const synced = syncPresetSearches(await listSearches(deps.kv), deps.now.toISOString());
    if (synced.changed) await saveSearches(deps.kv, synced.searches);
    const searches = synced.searches.filter((item) => item.enabled);
    const groups = groupByCriteria(searches);
    uniqueSearches = groups.size;
    const callWeight = [...groups.values()].reduce((sum, group) => sum + listingQueries(group[0]!).length, 0);
    hours = intervalHours(callWeight || 1);
    const intervalMs = hours * 60 * 60 * 1000;
    const alerts = await listAlerts(deps.kv);
    const freshAlerts: WatchAlert[] = [];

    promptGuard = await runGuard(searches, deps, servBudget("radar_guard", remain(), limits.serv), servChecks);
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

    const due: { key: string; group: SavedSearch[]; urls: string[] }[] = [];
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
      const urls: string[] = [];
      let halted = false;
      for (const query of listingQueries(group[0]!)) {
        const url = listingsSearchUrl(query);
        const cached = await readListingCache(deps.kv, url, deps.now.getTime());
        if (cached) {
          urls.push(url);
          continue;
        }
        if (remain() < 1_500) {
          notes.push("Stopped before another listings call so this run can be saved.");
          steps.push({ id: "listings", status: "partial", detail: "deadline" });
          halted = true;
          break;
        }
        const slot = await reserveRadarCall(deps.kv, deps.now);
        if (!slot.ok) {
          notes.push(slot.message);
          steps.push({ id: "listings", status: "budget", detail: slot.message });
          halted = true;
          break;
        }
        autodevCalls += 1;
        urls.push(url);
      }
      if (urls.length) due.push({ key, group, urls });
      if (halted) break;
    }

    const fetched = await Promise.all(
      due.map(async (job) => {
        const pages: Listing[] = [];
        const seenVin = new Set<string>();
        let error: string | undefined;
        for (const url of job.urls) {
          const cached = await readListingCache(deps.kv, url, deps.now.getTime());
          const result = Array.isArray(cached)
            ? { ok: true as const, listings: cached as Listing[] }
            : await fetchListings(url, deps.autodevKey!, deps.fetchImpl, Math.min(limits.autodev, remain()));
          if (!result.ok) {
            error = result.message;
            continue;
          }
          if (!Array.isArray(cached)) await writeListingCache(deps.kv, url, result.listings, deps.now.getTime());
          for (const listing of result.listings) {
            if (seenVin.has(listing.vin)) continue;
            seenVin.add(listing.vin);
            pages.push(listing);
          }
        }
        if (pages.length === 0) return { ...job, listings: null as Listing[] | null, error: error ?? "Listings call failed." };
        return { ...job, listings: pages, error: undefined as string | undefined };
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
      const asOfYear = deps.now.getUTCFullYear();
      const eligible = job.listings.filter((listing) => hardReject(listing, criteria, asOfYear) === null);
      for (const search of job.group) {
        if (isBroadFlip(search)) {
          const ranked = topFlipCandidates(job.listings, deps.now, ASSUMPTIONS.radarMaxAlertsPerSearch, {
            repairAbility: search.criteria.repairAbility,
            targetProfitUsd: search.criteria.minProfitUsd ?? null,
          });
          const storageKey = seenStorageKey(search.id, search.criteria);
          const book = await seenBook(deps.kv, storageKey);
          const fresh = ranked.flatMap((item) => {
            const previous = book.get(item.vin);
            if (previous !== undefined && !isPriceDrop(previous, item.listing.priceUsd)) return [];
            const priceDropFrom = previous != null && isPriceDrop(previous, item.listing.priceUsd) ? previous : null;
            return [{ ...item, priceDropFrom }];
          });
          tallyReason(reasons, "already seen", ranked.length - fresh.length);
          tallyReason(reasons, "Not enough similar cars", job.listings.length - ranked.length);
          passed += fresh.length;
          filteredOut += job.listings.length - fresh.length;
          for (const item of ranked) book.set(item.vin, item.listing.priceUsd);
          await storeSeenPrices(
            deps.kv,
            storageKey,
            [...book.entries()].map(([vin, priceUsd]) => ({ vin, priceUsd })),
          );
          const judged = await judgeFlipAlerts(fresh, deps, remain(), limits.serv, servChecks);
          if (deps.servKey && !judged?.decisions) notes.push("Flip explanation unavailable. The estimates below are from the scan only.");
          for (const item of fresh) {
            const decision = judged?.decisions?.get(item.vin);
            // Code owns the alert list. SERV may explain a skip preference, but it cannot suppress a ranked deal.
            const badge = priceBadge(item.listing, job.listings, { mode: "flip" });
            const numbers = {
              priceUsd: item.listing.priceUsd ?? 0,
              fairValueUsd: badge.fairValueUsd,
              priceLabel: badge.label,
              medianUsd: badge.fairValueUsd ?? item.resaleMidUsd ?? 0,
              lowUsd: item.resaleLowUsd ?? badge.fairValueUsd ?? 0,
              highUsd: item.resaleHighUsd ?? badge.fairValueUsd ?? 0,
              gapUsd: item.profitMidUsd ?? 0,
              miles: item.listing.miles,
              expectedMiles: null,
              roughMarginUsd: item.profitMidUsd,
            };
            const baseWhy = flipAlertWhy(item);
            const why = decision?.note
              ? decision.verdict === "skip"
                ? `${baseWhy} Review note (does not cancel this alert): ${decision.note}`
                : `${baseWhy} ${decision.note}`
              : deps.servKey && !decision
                ? `${baseWhy} The written check did not finish. These figures are from the scan.`
                : baseWhy;
            const flipCoverage = {
              mode: "flip" as const,
              sample: item.listing.source === "sample",
              dealerListingCount: job.listings.length,
              radiusMiles: search.criteria.radiusMiles,
              historyOnListing: item.listing.accidentCount !== null && item.listing.ownerCount !== null,
            };
            const alert = makeAlert(
              search,
              item.listing,
              why,
              numbers,
              deps.now.toISOString(),
              judged?.checks,
              coverageSentence(flipCoverage),
              coverageConfidence(flipCoverage),
              item.priceDropFrom,
              badge,
            );
            alerts.unshift(alert);
            freshAlerts.push(alert);
            alertsSent += 1;
          }
          search.lastCheckedAt = deps.now.toISOString();
          continue;
        }
        const storageKey = seenStorageKey(search.id, search.criteria);
        const book = await seenBook(deps.kv, storageKey);
        const scoped = job.listings.filter((listing) => matchesWatchModels(listing, search.criteria));
        tallyReason(reasons, "model does not match", job.listings.length - scoped.length);
        const fresh = scoped.filter((listing) => {
          const previous = book.get(listing.vin);
          return previous === undefined || isPriceDrop(previous, listing.priceUsd);
        });
        tallyReason(reasons, "already seen", scoped.length - fresh.length);
        const decisions = fresh.map((listing) => ({
          listing,
          decision: prefilterListing(listing, search.criteria, eligible, search.mode, deps.now.getUTCFullYear()),
          dropped: book.has(listing.vin),
        }));
        const passedRows = decisions.filter((item) => item.decision.pass);
        for (const item of decisions) {
          if (!item.decision.pass) tallyReason(reasons, item.decision.reason);
        }
        const winners = rankPasses(
          passedRows.flatMap((item) => {
            if (!item.decision.pass) return [];
            const previous = book.get(item.listing.vin);
            const dropped = previous != null && isPriceDrop(previous, item.listing.priceUsd);
            const why = dropped
              ? `Price dropped from ${previous.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} to the new asking price. ${item.decision.why}`
              : item.decision.why;
            return [{ listing: item.listing, numbers: item.decision.numbers, why, priceDropFrom: dropped ? previous : null }];
          }),
        ).slice(0, ASSUMPTIONS.radarMaxAlertsPerSearch);
        const winnerVins = new Set(winners.map((winner) => winner.listing.vin));
        tallyReason(reasons, "past the alert cap", passedRows.filter((item) => !winnerVins.has(item.listing.vin)).length);
        filteredOut += decisions.length - passedRows.length;
        passed += passedRows.length;
        for (const item of passedRows) book.set(item.listing.vin, item.listing.priceUsd);
        await storeSeenPrices(
          deps.kv,
          storageKey,
          [...book.entries()].map(([vin, priceUsd]) => ({ vin, priceUsd })),
        );
        for (const winner of winners) {
          const personalCoverage = {
            mode: "personal" as const,
            sample: winner.listing.source === "sample",
            dealerListingCount: scoped.length,
            radiusMiles: search.criteria.radiusMiles,
            historyOnListing: winner.listing.accidentCount !== null && winner.listing.ownerCount !== null,
          };
          const alert = makeAlert(
            search,
            winner.listing,
            winner.why,
            winner.numbers,
            deps.now.toISOString(),
            undefined,
            coverageSentence(personalCoverage),
            coverageConfidence(personalCoverage),
            winner.priceDropFrom,
            priceBadge(winner.listing, scoped, { mode: "personal" }),
          );
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
          if (alert.mode === "flip") return { why: alert.why, source: "flip_judge", checks: alert.checks ?? [] };
          try {
            return await reviewWhy(alert.why, alert.numbers, deps, servBudget("personal_alert_review", remain(), limits.serv), servChecks);
          } catch {
            return { why: alert.why, source: "timeout", checks: alert.checks ?? [] };
          }
        }),
      );
      reviews.forEach((review, index) => {
        const alert = freshAlerts[index];
        if (!alert) return;
        const unfinished = review.source === "timeout" || review.source === "template_after_error";
        alert.why = unfinished
          ? `${review.why} The written check did not finish. This match is calculated from the saved search.`
          : review.why;
        alert.checks = review.checks;
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
  servChecks: ServProof[],
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
    servChecks,
    payment,
  };
}

async function judgeFlipAlerts(
  fresh: ReturnType<typeof topFlipCandidates>,
  deps: CycleDeps,
  remainMs: number,
  ceilingMs: number,
  proofs: ServProof[],
): Promise<{ decisions: Map<string, { verdict: "alert" | "skip"; note: string }> | null; checks: DecisionProof[] } | null> {
  if (!deps.servKey || fresh.length === 0 || remainMs <= 0) return null;
  const facts = fresh.map((item) => ({
    vin: item.vin,
    year: item.listing.year,
    make: item.listing.make,
    model: item.listing.model,
    askingUsd: item.listing.priceUsd ?? 0,
    fairValueUsd: item.resaleMidUsd,
    compCount: item.compCount,
    profitLowUsd: item.profitLowUsd,
    profitMidUsd: item.profitMidUsd,
    profitHighUsd: item.profitHighUsd,
    confidence: item.confidence,
    speed: item.speed,
    speedBasis: item.speedBasis,
  }));
  const guards = proofs.filter((item) => item.purpose === "radar_guard").map(visibleProof);
  const deadline = Date.now() + remainMs;
  const budget = (id: ProfileId) => servBudget(id, deadline - Date.now(), ceilingMs);
  try {
    const rulesMs = budget("flip_feasibility");
    const rules =
      rulesMs < 500
        ? null
        : await runServ("flip_feasibility", { user: JSON.stringify({ facts }) }, {
            fetch: deps.fetchImpl,
            apiKey: deps.servKey,
            baseUrl: deps.servBaseUrl,
            model: deps.servModel,
            timeoutMs: rulesMs,
          });
    const allowed = JSON.stringify(facts);
    const rulesNote = rules?.ok && quotedNumbersStayIn(rules.text, allowed) ? rules.text : null;
    if (rules) {
      if (!rulesNote) rules.proof.fallbackUsed = true;
      proofs.push(rules.proof);
    }
    const judgeMs = budget("flip_judge");
    if (judgeMs < 500) return { decisions: null, checks: rules ? [...guards, visibleProof(rules.proof)] : guards };
    const judged = await runServ("flip_judge", { user: JSON.stringify({ facts, rulesNote }) }, {
      fetch: deps.fetchImpl,
      apiKey: deps.servKey,
      baseUrl: deps.servBaseUrl,
      model: deps.servModel,
      timeoutMs: judgeMs,
    });
    proofs.push(judged.proof);
    return {
      decisions: judged.ok ? parseFlipJudgment(judged.text, facts) : null,
      checks: [...guards, ...(rules ? [visibleProof(rules.proof)] : []), visibleProof(judged.proof)],
    };
  } catch {
    return { decisions: null, checks: guards };
  }
}

function parseFlipJudgment(
  text: string,
  facts: Array<{ vin: string } & Record<string, unknown>>,
): Map<string, { verdict: "alert" | "skip"; note: string }> | null {
  try {
    const parsed = JSON.parse(text) as { decisions?: Array<{ vin?: string; verdict?: string; note?: string }> };
    if (!Array.isArray(parsed.decisions)) return null;
    const allowed = JSON.stringify(facts);
    const known = new Set(facts.map((item) => item.vin));
    const decisions = new Map<string, { verdict: "alert" | "skip"; note: string }>();
    for (const decision of parsed.decisions) {
      if (!decision.vin || !known.has(decision.vin)) continue;
      if (decision.verdict !== "alert" && decision.verdict !== "skip") continue;
      const note = typeof decision.note === "string" ? decision.note : "";
      // Exact token membership against the computed facts — not JSON substring matching.
      const safe = !note.trim() || quotedNumbersStayIn(note, allowed);
      decisions.set(decision.vin, { verdict: decision.verdict, note: safe ? note : "" });
    }
    return decisions;
  } catch {
    return null;
  }
}

async function runGuard(searches: SavedSearch[], deps: CycleDeps, timeoutMs: number, proofs: ServProof[]): Promise<string> {
  if (!deps.servKey) return "not_configured";
  const text = searches.map((item) => `${item.name} ${item.mode} ${item.criteria.zip} ${item.criteria.priceMax}`).join("\n");
  if (!text.trim()) return "skipped_empty";
  if (timeoutMs <= 0) return "timeout";
  try {
    const result = await withTimeout(
      runServ("radar_guard", { user: text }, {
        fetch: deps.fetchImpl,
        apiKey: deps.servKey,
        baseUrl: deps.servBaseUrl,
        model: deps.servModel,
        timeoutMs,
      }),
      timeoutMs,
    );
    proofs.push(result.proof);
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
  proofs: ServProof[],
): Promise<{ why: string; source: string; checks: DecisionProof[] }> {
  const guards = proofs.filter((item) => item.purpose === "radar_guard").map(visibleProof);
  if (!deps.servKey) return { why, source: "template", checks: guards };
  if (timeoutMs <= 0) return { why, source: "timeout", checks: guards };
  const result = await runServ("personal_alert_review", { user: JSON.stringify({ alert: why, facts: numbers }) }, {
    fetch: deps.fetchImpl,
    apiKey: deps.servKey,
    baseUrl: deps.servBaseUrl,
    model: deps.servModel,
    timeoutMs,
  });
  proofs.push(result.proof);
  const checks = [...guards, visibleProof(result.proof)];
  if (!result.ok) return { why, source: result.error === "SERV did not respond." ? "timeout" : "template_after_error", checks };
  // Only numbers from this alert's computed payload — never invent fee/recon constants.
  const numbersOk = quotedNumbersStayIn(result.text, JSON.stringify({ alert: why, facts: numbers }));
  const failed = result.shadowOutcome === "exhausted" || result.shadowOutcome === "failed";
  if (!numbersOk || failed) return { why, source: failed ? "shadow_rejected" : "audit_rejected", checks };
  return { why: result.text, source: result.shadowOutcome, checks };
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

function makeAlert(
  search: SavedSearch,
  listing: Listing,
  why: string,
  numbers: WatchAlert["numbers"],
  iso: string,
  checks?: DecisionProof[],
  coverage?: string,
  coverageLevel?: WatchAlert["coverageLevel"],
  priceDropFrom?: number | null,
  badge?: WatchAlert["badge"],
): WatchAlert {
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
    checks,
    coverage,
    coverageLevel,
    priceDropFrom,
    badge,
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
  if (await telegramPaused(deps.kv, alert.ownerId)) return "skipped";
  const search = (await listSearches(deps.kv)).find((item) => item.id === alert.searchId);
  const criteria = search?.criteria;
  const copy: AlertCopy = {
    searchName: search?.name ?? "Saved search",
    mode: alert.mode,
    year: alert.year,
    make: alert.make,
    model: alert.model,
    priceUsd: alert.priceUsd,
    miles: alert.miles,
    city: alert.city,
    state: alert.state,
    priceDropFrom: alert.priceDropFrom ?? null,
    budgetUsd: criteria?.priceMax ?? null,
    radiusMiles: criteria?.radiusMiles ?? null,
    zip: criteria?.zip ?? null,
    yearMin: criteria?.yearMin ?? null,
    yearMax: criteria?.yearMax ?? null,
    milesMax: criteria?.milesMax ?? null,
    bodyStyle: criteria?.bodyStyle ?? null,
    priceLabel: alert.badge?.label ?? alert.numbers.priceLabel,
    fairValueUsd: alert.badge?.fairValueUsd ?? alert.numbers.fairValueUsd,
    origin: deps.origin,
    alertId: alert.id,
  };
  const message = alertMessage(copy);
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
