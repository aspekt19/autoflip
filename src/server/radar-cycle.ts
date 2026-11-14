import { createHash, randomUUID } from "node:crypto";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { priceBadge } from "@/domain/price-badge";
import {
  formatFilterBreakdown,
  groupByCriteria,
  hardReject,
  isDue,
  radarCandidateForServ,
  rankPasses,
  seenStorageKey,
  tallyReason,
  type SavedSearch,
  type WatchAlert,
} from "@/domain/radar-watch";
import {
  incrementServUsage,
  intervalHoursForWatch,
  plansFor,
  servAllowanceRemaining,
  type StoredPlans,
} from "@/server/plan-book";
import { topFlipCandidates, flipAlertWhy } from "@/domain/flip-rank";
import { isBroadFlip, isPriceDrop, listingQueries, matchesWatchModels } from "@/domain/watch-queries";
import { listingsSearchUrl } from "@/io/autodev";
import type { Kv } from "@/io/kv";
import { storageMode } from "@/io/kv";
import { parseAutoDevListings } from "@/io/parsers";
import { reserveRadarCall } from "@/io/persistent-quota";
import { coverageConfidence, coverageSentence } from "@/domain/coverage";
import { visibleProof, type DecisionProof } from "@/domain/decision-note";
import { decisionStepBudget, interpretGuard, runServ, type ServProof } from "@/server/serv";
import type { Listing } from "@/domain/types";
import { journalFromRadarActivity } from "@/domain/radar-activity-journal";
import { upsertNotReviewedAlert } from "@/domain/radar-review-activity";
import {
  buildDecisionProofRecord,
  RADAR_VERDICT_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";
import { providerResponseIdFromCall } from "@/domain/serv-response-id";
import { decideRadarFlip, flipCandidateOutcome } from "@/server/serv-plan-decide";
import { reviewPersonalCandidate, type RadarServActivity } from "./radar-serv";
import {
  radarAlertKeyboard,
  radarAlertTelegramText,
} from "@/io/telegram";
import {
  listSearches,
  upsertRun,
  saveAlerts,
  saveSearches,
  seenBook,
  storeSeenPrices,
  readListingCache,
  writeListingCache,
  telegramChat,
  telegramPaused,
  type StoredRun,
  listAlerts,
} from "./radar-store";
import {
  acquireRadarTestCycle,
  releaseRadarTestCycle,
  stopRadarAfterFirstTestAlert,
  isRadarTestModeEnabled,
} from "./radar-test-mode";

/** Stay under the 300s route cap so the log write still happens. */
export const CYCLE_BUDGET_MS = 270_000;

const CALL_MS = {
  autodev: 8_000,
  /** One decision step. Shorter than this is an honest stop, not a clipped review. */
  serv: 90_000,
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
  /** Production test mode can restrict the project-wide monitor to one saved watch. */
  maxEnabledWatches?: number;
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
  const testModeEnabled = isRadarTestModeEnabled(deps.env);
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
  const servActivity: RadarServActivity[] = [];
  const proofRecords: DecisionProofRecord[] = [];
  const touchedOwnerIds = new Set<string>();
  const touchedSearchIds = new Set<string>();
  const perSearchStats = new Map<string, { listings: number; alertsSent: number }>();
  const bumpSearch = (searchId: string, patch: { listings?: number; alertsSent?: number }) => {
    const prior = perSearchStats.get(searchId) ?? { listings: 0, alertsSent: 0 };
    perSearchStats.set(searchId, {
      listings: prior.listings + (patch.listings ?? 0),
      alertsSent: prior.alertsSent + (patch.alertsSent ?? 0),
    });
  };
  let payment: StoredRun["payment"] = {
    status: "not_configured",
    missing: [],
    tx: null,
    detail: "The daily check does not take a per-run payment.",
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
      [...touchedOwnerIds],
      [...touchedSearchIds],
      servActivity,
      [...perSearchStats.entries()].map(([searchId, row]) => ({
        searchId,
        listings: row.listings,
        alertsSent: row.alertsSent,
      })),
      proofRecords,
    );

  const gate = await acquireRadarTestCycle(deps.kv, runId, deps.env);
  if (!gate.ok) {
    notes.push(gate.message);
    steps.push({ id: "trial_safety", status: gate.stopped ? "stopped" : "skipped" });
    const run = snapshot();
    await upsertRun(deps.kv, run).catch(() => undefined);
    return run;
  }

  try {
    // Never inject demo/preset watches on cron — only user-saved searches run in prod.
    const allSavedSearches = await listSearches(deps.kv);
    const enabledSearches = allSavedSearches.filter((item) => item.enabled);
    const orderedSearches = [...enabledSearches].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    const watchLimit =
      typeof deps.maxEnabledWatches === "number" ? Math.max(0, Math.floor(deps.maxEnabledWatches)) : null;
    const searches = watchLimit === null ? orderedSearches : orderedSearches.slice(0, watchLimit);
    if (watchLimit !== null && enabledSearches.length > searches.length) {
      const keepIds = new Set(searches.map((item) => item.id));
      await saveSearches(
        deps.kv,
        allSavedSearches.map((item) =>
          item.enabled && !keepIds.has(item.id) ? { ...item, enabled: false } : item,
        ),
      );
      notes.push(
        `Test mode allows ${watchLimit} project-wide active watch${watchLimit === 1 ? "" : "es"}. Additional active watches were paused before external lookups.`,
      );
    }
    const groups = groupByCriteria(searches);
    uniqueSearches = groups.size;
    const planCache = new Map<string, StoredPlans>();
    const plansOf = async (ownerId: string) => {
      const hit = planCache.get(ownerId);
      if (hit) return hit;
      const row = await plansFor(deps.kv, ownerId);
      planCache.set(ownerId, row);
      return row;
    };
    // Representative run interval = shortest cadence among paid enabled watches (for activity log).
    let minInterval = Number.POSITIVE_INFINITY;
    for (const item of searches) {
      const plans = await plansOf(item.ownerId);
      const h = intervalHoursForWatch(item.mode, plans);
      if (Number.isFinite(h)) minInterval = Math.min(minInterval, h);
    }
    hours = Number.isFinite(minInterval) ? minInterval : 6;
    const alerts = await listAlerts(deps.kv);
    const freshAlerts: WatchAlert[] = [];

    const guardText = searches.map((item) => `${item.name} ${item.mode} ${item.criteria.zip} ${item.criteria.priceMax}`).join("\n");
    const guardCacheKey = `radar:guard:allow:v1:${createHash("sha256").update(guardText).digest("hex")}`;
    const guardAlreadyAllowed = (await deps.kv.get(guardCacheKey)) === "allow";
    const guardResult = guardAlreadyAllowed
      ? {
          status: "allow" as const,
          activity: null,
          proofRecord: buildDecisionProofRecord({
            purpose: "radar_guard",
            rubricId: RADAR_VERDICT_RUBRIC_ID,
            status: "ok",
            recordedAt: deps.now.toISOString(),
            inputs: { searchCount: searches.length, zips: searches.map((item) => item.criteria.zip) },
            detail: "Identical saved criteria were already allowed by SERV. Reused the durable guard result; no new SERV request was sent.",
          }),
        }
      : await runGuard(
          searches,
          deps,
          decisionStepBudget("radar_guard", remain(), limits.serv) ?? 0,
          servChecks,
        );
    if (!guardAlreadyAllowed && guardResult.status === "allow") {
      await deps.kv.set(guardCacheKey, "allow").catch(() => undefined);
    }
    promptGuard = guardAlreadyAllowed ? "allow_cached" : guardResult.status;
    if (guardResult.activity) servActivity.push(guardResult.activity);
    // Stamp one guard proof per watch so Check/feed can filter by owner/search.
    if (guardResult.proofRecord && searches.length > 0) {
      for (const search of searches) {
        proofRecords.push({
          ...guardResult.proofRecord,
          searchId: search.id,
          ownerId: search.ownerId,
        });
      }
    } else if (guardResult.proofRecord) {
      proofRecords.push(guardResult.proofRecord);
    }
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
      // Paid-only: skip watches whose owner has no active radar plan.
      const paidGroup: SavedSearch[] = [];
      for (const item of group) {
        const plans = await plansOf(item.ownerId);
        const interval = intervalHoursForWatch(item.mode, plans);
        if (!Number.isFinite(interval) || interval <= 0) continue;
        paidGroup.push(item);
      }
      if (paidGroup.length === 0) {
        skippedDue += group.length;
        continue;
      }
      let ready = Boolean(deps.forceAll);
      if (!ready) {
        for (const item of paidGroup) {
          const plans = await plansOf(item.ownerId);
          const intervalMs = intervalHoursForWatch(item.mode, plans) * 60 * 60 * 1000;
          if (isDue(item.lastCheckedAt, deps.now.getTime(), intervalMs)) {
            ready = true;
            break;
          }
        }
      }
      if (!ready) {
        skippedDue += group.length;
        continue;
      }
      if (!deps.autodevKey) {
        stamp(paidGroup, deps.now.toISOString());
        continue;
      }
      const urls: string[] = [];
      let halted = false;
      for (const query of listingQueries(paidGroup[0]!)) {
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
      if (urls.length) due.push({ key, group: paidGroup, urls });
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
      if (testModeEnabled && freshAlerts.length > 0) break;
      if (!job.listings) {
        notes.push(job.error ?? "Listings call failed.");
        if (job.error === "timeout") listingTimeouts += 1;
        stamp(job.group, deps.now.toISOString());
        continue;
      }
      listings += job.listings.length;
      for (const search of job.group) {
        if (testModeEnabled && freshAlerts.length > 0) break;
        if (isBroadFlip(search)) {
          const ranked = topFlipCandidates(job.listings, deps.now, ASSUMPTIONS.radarMaxAlertsPerSearch, {
            repairAbility: search.criteria.repairAbility,
            targetProfitUsd: search.criteria.minProfitUsd ?? null,
            milesMax: search.criteria.milesMax,
            enforceSanity: true,
          });
          const storageKey = seenStorageKey(search.id, search.criteria);
          const book = await seenBook(deps.kv, storageKey);
          // Force re-review of stuck not_reviewed rows within this search so SERV
          // (radar_review) actually runs again instead of leaving them forever.
          const pendingNotReviewed = alerts.filter(
            (row) => row.searchId === search.id && row.status === "not_reviewed",
          );
          for (const pending of pendingNotReviewed) {
            book.delete(pending.vin);
          }
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
          // Mark non-fresh priced listings as seen. Fresh VINs stay out until SERV
          // decides alert/skip — a missing decision must remain reviewable next run.
          const freshVins = new Set(fresh.map((item) => item.vin));
          for (const listing of job.listings) {
            if (listing.priceUsd == null) continue;
            if (freshVins.has(listing.vin)) continue;
            book.set(listing.vin, listing.priceUsd);
          }
          touchedOwnerIds.add(search.ownerId);
          touchedSearchIds.add(search.id);
          bumpSearch(search.id, { listings: job.listings.length });
          let judged: Awaited<ReturnType<typeof decideRadarFlip>> | null = null;
          if (fresh.length > 0 && deps.servKey) {
            const ownerPlans = await plansOf(search.ownerId);
            const servSlot = await servAllowanceRemaining(deps.kv, search.ownerId, ownerPlans);
            if (!servSlot.ok) {
              notes.push(servSlot.message);
            } else {
              // Thin decide façade — PR B plugs into decideRadarFlip / ports.decideRadarFlip.
              judged = await decideRadarFlip({
                fresh,
                searchId: search.id,
                remainMs: remain(),
                ceilingMs: limits.serv,
                servKey: deps.servKey,
                servBaseUrl: deps.servBaseUrl,
                servModel: deps.servModel,
                fetchImpl: deps.fetchImpl,
                nowIso: deps.now.toISOString(),
                guardProofs: servChecks,
              });
              // One batched radar_review HTTP round-trip counts as one SERV call toward the plan cap.
              if (judged?.activity?.length) {
                await incrementServUsage(deps.kv, search.ownerId, 1);
              }
            }
          } else if (fresh.length > 0) {
            judged = await decideRadarFlip({
              fresh,
              searchId: search.id,
              remainMs: remain(),
              ceilingMs: limits.serv,
              servKey: deps.servKey,
              servBaseUrl: deps.servBaseUrl,
              servModel: deps.servModel,
              fetchImpl: deps.fetchImpl,
              nowIso: deps.now.toISOString(),
              guardProofs: servChecks,
            });
          }
          if (judged?.activity?.length) {
            servActivity.push(...(judged.activity as RadarServActivity[]));
          }
          if (judged?.stoppedReason) notes.push(judged.stoppedReason);
          if (deps.servKey && fresh.length > 0 && !judged?.decisions) {
            notes.push(
              judged?.stoppedReason
                ? "Candidates were left as Not reviewed so they can be checked again next run."
                : "Flip explanation unavailable. Candidates were left as Not reviewed so they can be checked again next run.",
            );
          }
          for (const item of fresh) {
            if (testModeEnabled && freshAlerts.length > 0) break;
            const badge = priceBadge(item.listing, job.listings, { mode: "flip" });
            const numbers = {
              priceUsd: item.listing.priceUsd ?? 0,
              fairValueUsd: badge.fairValueUsd,
              priceLabel: badge.label,
              medianUsd: badge.fairValueUsd ?? 0,
              lowUsd: badge.fairValueUsd == null ? 0 : (item.resaleLowUsd ?? badge.fairValueUsd),
              highUsd: badge.fairValueUsd == null ? 0 : (item.resaleHighUsd ?? badge.fairValueUsd),
              gapUsd: item.profitMidUsd ?? 0,
              miles: item.listing.miles,
              expectedMiles: null,
              roughMarginUsd: item.profitMidUsd,
            };
            const baseWhy = flipAlertWhy(item);
            const flipCoverage = {
              mode: "flip" as const,
              sample: item.listing.source === "sample",
              dealerListingCount: job.listings.length,
              radiusMiles: search.criteria.radiusMiles,
              historyOnListing: item.listing.accidentCount !== null && item.listing.ownerCount !== null,
            };
            const outcome = flipCandidateOutcome({
              hasServKey: Boolean(deps.servKey),
              // null judged / null decisions → no decision map (timeout, empty payload, budget).
              decisions: judged?.decisions ?? null,
              vin: item.vin,
              baseWhy,
            });
            if (outcome.kind === "serv_skipped") {
              const skipped = makeAlert(
                search,
                item.listing,
                outcome.why,
                numbers,
                deps.now.toISOString(),
                judged?.checks,
                coverageSentence(flipCoverage),
                coverageConfidence(flipCoverage),
                item.priceDropFrom,
                badge,
                "serv_skipped",
              );
              alerts.unshift(skipped);
              if (item.listing.priceUsd != null) book.set(item.vin, item.listing.priceUsd);
              continue;
            }
            if (outcome.kind === "not_reviewed") {
              const pending = makeAlert(
                search,
                item.listing,
                outcome.why,
                numbers,
                deps.now.toISOString(),
                judged?.checks,
                coverageSentence(flipCoverage),
                coverageConfidence(flipCoverage),
                item.priceDropFrom,
                badge,
                "not_reviewed",
              );
              // Replace prior not_reviewed for this search+VIN so the 80-alert cap stays honest.
              const next = upsertNotReviewedAlert(alerts, pending);
              alerts.length = 0;
              alerts.push(...next);
              // Leave out of seen book so the next run can re-review.
              continue;
            }
            const why =
              outcome.kind === "alert" && outcome.whySuffix
                ? `${baseWhy} ${outcome.whySuffix}`
                : outcome.kind === "code_alert"
                  ? outcome.why
                  : baseWhy;
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
            bumpSearch(search.id, { alertsSent: 1 });
            if (item.listing.priceUsd != null) book.set(item.vin, item.listing.priceUsd);
          }
          await storeSeenPrices(
            deps.kv,
            storageKey,
            [...book.entries()].map(([vin, priceUsd]) => ({ vin, priceUsd })),
          );
          search.lastCheckedAt = deps.now.toISOString();
          continue;
        }
        const storageKey = seenStorageKey(search.id, search.criteria);
        const book = await seenBook(deps.kv, storageKey);
        // Drop stuck not_reviewed / code-only rows from the seen book BEFORE fresh
        // filtering so verdict_decide can run again within the SERV cap.
        // Code-only retries only when SERV is configured now — otherwise every Check
        // would re-alert the same VINs forever.
        const needsDecide = alerts.filter(
          (row) =>
            row.searchId === search.id &&
            (row.status === "not_reviewed" ||
              (Boolean(deps.servKey) &&
                row.status === "new" &&
                /uses the code price rating only/i.test(row.why))),
        );
        for (const pending of needsDecide) {
          book.delete(pending.vin);
        }
        const scoped = job.listings.filter((listing) => matchesWatchModels(listing, search.criteria));
        tallyReason(reasons, "model does not match", job.listings.length - scoped.length);
        const fresh = scoped.filter((listing) => {
          const previous = book.get(listing.vin);
          return previous === undefined || isPriceDrop(previous, listing.priceUsd);
        });
        tallyReason(reasons, "already seen", scoped.length - fresh.length);
        const decisions = fresh.map((listing) => ({
          listing,
          // Hard watch criteria only. Soft tone/margin prefilter is deleted — SERV decides.
          // Same pool as the badge below so comps stay consistent with displayed facts.
          decision: radarCandidateForServ(listing, search.criteria, scoped, search.mode, deps.now.getUTCFullYear()),
          dropped: book.has(listing.vin),
        }));
        const passedRows = decisions.filter((item) => item.decision.pass);
        for (const item of decisions) {
          if (!item.decision.pass) tallyReason(reasons, item.decision.reason);
        }
        const ranked = rankPasses(
          passedRows.flatMap((item) => {
            if (!item.decision.pass) return [];
            const previous = book.get(item.listing.vin);
            const dropped = previous != null && isPriceDrop(previous, item.listing.priceUsd);
            const why = dropped
              ? `Price dropped from ${previous.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} to the new asking price. ${item.decision.why}`
              : item.decision.why;
            return [{ listing: item.listing, numbers: item.decision.numbers, why, priceDropFrom: dropped ? previous : null }];
          }),
        );
        const winners = ranked.slice(0, ASSUMPTIONS.radarMaxServPerSearch);
        tallyReason(reasons, "past the SERV/alert cap", Math.max(0, ranked.length - winners.length));
        filteredOut += decisions.length - passedRows.length;
        passed += passedRows.length;
        // Mark non-winner hard-matched rows as seen. Winners stay unmarked until SERV
        // finishes so a failed verdict_decide can retry on the next Check.
        const winnerVins = new Set(winners.map((row) => row.listing.vin));
        for (const item of decisions) {
          if (hardReject(item.listing, search.criteria, deps.now.getUTCFullYear())) continue;
          if (item.listing.priceUsd == null) continue;
          if (winnerVins.has(item.listing.vin)) continue;
          book.set(item.listing.vin, item.listing.priceUsd);
        }
        touchedOwnerIds.add(search.ownerId);
        touchedSearchIds.add(search.id);
        bumpSearch(search.id, { listings: scoped.length });
        let servSlot = 0;
        for (const winner of winners) {
          if (testModeEnabled && freshAlerts.length > 0) break;
          // Observational badge facts only — do not drop before SERV on tone.
          const badge = priceBadge(winner.listing, scoped, { mode: "personal" });
          const personalCoverage = {
            mode: "personal" as const,
            sample: winner.listing.source === "sample",
            dealerListingCount: scoped.length,
            radiusMiles: search.criteria.radiusMiles,
            historyOnListing: winner.listing.accidentCount !== null && winner.listing.ownerCount !== null,
          };
          servSlot += 1;
          // Always go through reviewPersonalCandidate — missing SERV key is an honest
          // skip (no code-price-only alert), not an inline alertWorthy:true bypass.
          if (deps.servKey) {
            const ownerPlans = await plansOf(search.ownerId);
            const servCap = await servAllowanceRemaining(deps.kv, search.ownerId, ownerPlans);
            if (!servCap.ok) {
              notes.push(servCap.message);
              tallyReason(reasons, "monthly SERV cap");
              continue;
            }
          }
          const review = await reviewPersonalCandidate(
            {
              listing: winner.listing,
              numbers: winner.numbers,
              badge,
              baseWhy: winner.why,
              budgetUsd: search.criteria.priceMax,
            },
            {
              fetchImpl: deps.fetchImpl,
              servKey: deps.servKey,
              servModel: deps.servModel,
              servBaseUrl: deps.servBaseUrl,
              timeoutMs: decisionStepBudget("verdict_decide", remain(), limits.serv) ?? 0,
              searchId: search.id,
              challenge: Boolean(deps.servKey) && servSlot === 1,
              nowIso: deps.now.toISOString(),
            },
            servChecks,
          );
          if (deps.servKey && review.activity.some((row) => row.profile === "verdict_decide")) {
            await incrementServUsage(deps.kv, search.ownerId, 1);
          }
          servActivity.push(...review.activity);
          proofRecords.push(
            ...(review.proofRecords ?? []).map((row) => ({
              ...row,
              searchId: search.id,
              ownerId: search.ownerId,
            })),
          );
          if (!review.alertWorthy) {
            const decideRow = review.activity.find((row) => row.profile === "verdict_decide");
            const servFailed = Boolean(decideRow && !decideRow.ok);
            if (servFailed || (deps.servKey && !decideRow?.ok && review.action == null)) {
              const pending = makeAlert(
                search,
                winner.listing,
                `Not reviewed — SERV verdict_decide did not finish (will retry on next Check). ${winner.why}`,
                winner.numbers,
                deps.now.toISOString(),
                review.checks.length ? review.checks : undefined,
                coverageSentence(personalCoverage),
                coverageConfidence(personalCoverage),
                winner.priceDropFrom,
                badge,
                "not_reviewed",
                (review.proofRecords ?? []).map((row) => ({
                  ...row,
                  searchId: search.id,
                  ownerId: search.ownerId,
                })),
              );
              const next = upsertNotReviewedAlert(alerts, pending);
              alerts.length = 0;
              alerts.push(...next);
              tallyReason(reasons, "SERV did not finish — left Not reviewed");
              // Leave out of seen book so the next Check can re-run verdict_decide.
              continue;
            }
            // SERV reviewed and chose pass / needs_inspection — not an alert.
            const skipped = makeAlert(
              search,
              winner.listing,
              `Reviewed — skipped: ${review.why}`,
              winner.numbers,
              deps.now.toISOString(),
              review.checks.length ? review.checks : undefined,
              coverageSentence(personalCoverage),
              coverageConfidence(personalCoverage),
              winner.priceDropFrom,
              badge,
              "serv_skipped",
              (review.proofRecords ?? []).map((row) => ({
                ...row,
                searchId: search.id,
                ownerId: search.ownerId,
              })),
            );
            alerts.unshift(skipped);
            if (winner.listing.priceUsd != null) book.set(winner.listing.vin, winner.listing.priceUsd);
            tallyReason(reasons, "SERV did not rate good/fair");
            continue;
          }
          const alert = makeAlert(
            search,
            winner.listing,
            review.why,
            winner.numbers,
            deps.now.toISOString(),
            review.checks.length ? review.checks : undefined,
            coverageSentence(personalCoverage),
            coverageConfidence(personalCoverage),
            winner.priceDropFrom,
            badge,
            "new",
            (review.proofRecords ?? []).map((row) => ({
              ...row,
              searchId: search.id,
              ownerId: search.ownerId,
            })),
          );
          alerts.unshift(alert);
          freshAlerts.push(alert);
          alertsSent += 1;
          bumpSearch(search.id, { alertsSent: 1 });
          if (winner.listing.priceUsd != null) book.set(winner.listing.vin, winner.listing.priceUsd);
        }
        await storeSeenPrices(
          deps.kv,
          storageKey,
          [...book.entries()].map(([vin, priceUsd]) => ({ vin, priceUsd })),
        );
        search.lastCheckedAt = deps.now.toISOString();
      }
    }
    filterBreakdown = formatFilterBreakdown(reasons);
    steps.push({
      id: "listings",
      status: listingTimeouts > 0 ? "timeout" : "ok",
      detail: `${listings} rows, ${autodevCalls} calls`,
    });

    await saveAlerts(deps.kv, alerts);
    const mergedSearches = await mergeChecked(deps.kv, searches);
    if (testModeEnabled && freshAlerts.length > 0) {
      const firstAlert = freshAlerts[0]!;
      const stopped = await stopRadarAfterFirstTestAlert(deps.kv, firstAlert.id, deps.now.toISOString(), deps.env);
      await saveSearches(
        deps.kv,
        mergedSearches.map((item) => ({ ...item, enabled: false })),
      );
      notes.push(stopped.message ?? "Deal Radar was paused after its first test notification.");
      steps.push({ id: "trial_safety", status: "stopped", detail: `first alert ${firstAlert.id}; all watches disabled` });
    } else {
      await saveSearches(deps.kv, mergedSearches);
    }
    shadow = deps.servKey ? "pending" : "not_configured";
    await upsertRun(deps.kv, snapshot());

    // Personal alerts already ran verdict_decide (+ optional challenge) above.
    // Flip alerts record flip_judge activity via decideRadarFlip (serv-plan-decide).
    if (!deps.servKey) {
      shadow = "not_configured";
      steps.push({ id: "serv_verdict", status: "not_configured" });
    } else if (servActivity.length === 0 && freshAlerts.every((alert) => alert.mode === "flip")) {
      shadow = freshAlerts.length === 0 ? "no_alerts" : "flip_judge";
      steps.push({ id: "serv_verdict", status: shadow });
    } else if (servActivity.length === 0) {
      shadow = "no_candidates";
      steps.push({ id: "serv_verdict", status: "no_candidates" });
    } else {
      shadow = summarizeShadow(servActivity.map((row) => (row.ok ? row.decision ?? "ok" : "error")));
      const httpCallKeys = new Set(
        servActivity.map((row) =>
          row.callId?.trim()
            ? `${row.profile}::call:${row.callId.trim()}`
            : row.responseId?.trim()
              ? `${row.profile}::${row.responseId.trim()}`
              : `${row.profile}::at:${row.at}::lat:${row.latencyMs}`,
        ),
      );
      steps.push({
        id: "serv_verdict",
        status: servActivity.some((row) => !row.ok) ? "partial" : "ok",
        detail: `${httpCallKeys.size} HTTP call${httpCallKeys.size === 1 ? "" : "s"} · ${servActivity.length} decisions · ${shadow}`,
      });
    }
    await saveAlerts(deps.kv, alerts);

    // No outbound email provider is configured in this repo (Firebase auth only).
    notes.push("Email alerts are not configured. New matches stay in the Deal Radar page.");
    steps.push({ id: "email", status: "not_configured", detail: "No email provider in this repo." });

    notes.push("New matches stay on the Deal Radar page.");
    steps.push({ id: "delivery", status: "in_app", detail: "Alerts stay in the app." });

    // Telegram — failure never blocks the Radar run; log per alert.
    const telegramToken = deps.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!telegramToken) {
      steps.push({ id: "telegram", status: "not_configured" });
    } else if (freshAlerts.length === 0) {
      steps.push({ id: "telegram", status: "no_alerts" });
    } else {
      const searchesNow = await listSearches(deps.kv);
      let sent = 0;
      let failed = 0;
      for (const alert of freshAlerts) {
        try {
          if (await telegramPaused(deps.kv, alert.ownerId)) continue;
          const chatId = await telegramChat(deps.kv, alert.ownerId);
          if (!chatId) continue;
          const search = searchesNow.find((s) => s.id === alert.searchId);
          const reportUrl = `${deps.origin.replace(/\/$/, "")}/radar#alert-${alert.id}`;
          const text = radarAlertTelegramText({
            year: alert.year,
            make: alert.make,
            model: alert.model,
            priceUsd: alert.priceUsd,
            miles: alert.miles,
            distanceMiles: alert.distanceMiles ?? null,
            radiusCheck: alert.radiusCheck ?? (alert.distanceMiles == null ? "unverified" : "known"),
            listingUrl: alert.listingUrl ?? null,
            reportUrl,
            searchName: search?.name ?? null,
            openingOffer: alert.openingOffer,
            walkAway: alert.walkAway,
          });
          const reply_markup = radarAlertKeyboard(reportUrl, alert.listingUrl ?? null);
          const res = await deps.fetchImpl(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text, reply_markup }),
            signal: AbortSignal.timeout(Math.min(5_000, Math.max(500, remain()))),
          });
          if (res.ok) sent += 1;
          else {
            failed += 1;
            notes.push(`Telegram alert ${alert.id} failed: HTTP ${res.status}`);
          }
        } catch (err) {
          failed += 1;
          notes.push(
            `Telegram alert ${alert.id} failed: ${err instanceof Error ? err.message : "send error"}`,
          );
        }
      }
      steps.push({
        id: "telegram",
        status: failed > 0 ? "partial" : sent > 0 ? "ok" : "no_chat",
        detail: `sent=${sent} failed=${failed}`,
      });
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
  } finally {
    await releaseRadarTestCycle(deps.kv, runId);
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
  ownerIds: string[],
  searchIds: string[],
  servActivity: RadarServActivity[],
  perSearch: NonNullable<StoredRun["perSearch"]> = [],
  proofRecords: import("@/domain/decision-proof-record").DecisionProofRecord[] = [],
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
    ownerIds,
    searchIds,
    servActivity,
    decisionJournal: journalFromRadarActivity(servActivity, {
      notes,
      startedAt,
      filterBreakdown,
    }),
    proofRecords,
    perSearch,
    payment,
  };
}

async function runGuard(
  searches: SavedSearch[],
  deps: CycleDeps,
  timeoutMs: number,
  proofs: ServProof[],
): Promise<{
  status: string;
  activity: RadarServActivity | null;
  proofRecord: DecisionProofRecord | null;
}> {
  const searchId = searches[0]?.id ?? "radar";
  const at = deps.now.toISOString();
  const guardInputs = {
    searchCount: searches.length,
    zips: searches.map((item) => item.criteria.zip),
  };
  if (!deps.servKey) {
    return {
      status: "not_configured",
      activity: null,
      proofRecord: buildDecisionProofRecord({
        purpose: "radar_guard",
        rubricId: RADAR_VERDICT_RUBRIC_ID,
        status: "skipped_no_key",
        recordedAt: at,
        inputs: guardInputs,
        detail: "SERV_API_KEY is not configured — radar guard skipped.",
      }),
    };
  }
  const text = searches.map((item) => `${item.name} ${item.mode} ${item.criteria.zip} ${item.criteria.priceMax}`).join("\n");
  if (!text.trim()) {
    return {
      status: "skipped_empty",
      activity: null,
      proofRecord: buildDecisionProofRecord({
        purpose: "radar_guard",
        rubricId: RADAR_VERDICT_RUBRIC_ID,
        status: "skipped_no_evidence",
        recordedAt: at,
        inputs: guardInputs,
        detail: "No saved-search criteria text to guard.",
      }),
    };
  }
  const guardCallId = randomUUID();
  if (timeoutMs <= 0) {
    return {
      status: "timeout",
      activity: {
        at,
        searchId,
        vin: "",
        profile: "radar_guard",
        modelRequested: deps.servModel ?? "",
        modelReported: "",
        callId: guardCallId,
        responseId: null,
        latencyMs: 0,
        ok: false,
        decision: "timeout",
        note: "Stopped: radar_guard needs 90 seconds. No shorter check was sent.",
        alerted: false,
      },
      proofRecord: buildDecisionProofRecord({
        purpose: "radar_guard",
        rubricId: RADAR_VERDICT_RUBRIC_ID,
        status: "error",
        recordedAt: at,
        inputs: guardInputs,
        detail: "Stopped: radar_guard needs 90 seconds. No shorter check was sent.",
      }),
    };
  }
  try {
    const started = Date.now();
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
    const latencyMs = result.proof.latencyMs ?? Date.now() - started;
    const timedOut = !result.ok && (result.error === "SERV did not respond." || result.status === 0);
    const status = !result.ok
      ? timedOut
        ? "timeout"
        : `error: ${result.error}`
      : interpretGuard(result.text);
    const secs = Math.max(1, Math.round(latencyMs / 1000));
    const responseId = providerResponseIdFromCall({
      ok: result.ok && status !== "block",
      id: typeof result.proof.openserv?.id === "string" ? result.proof.openserv.id : null,
    });
    const note = timedOut
      ? `SERV timed out after ${secs}s`
      : result.ok
        ? `prompt guard: ${status}`
        : result.error ?? "radar_guard failed";
    return {
      status,
      activity: {
        at,
        searchId,
        vin: "",
        profile: "radar_guard",
        modelRequested: result.proof.modelRequested ?? deps.servModel ?? "",
        modelReported: result.proof.modelReported ?? "",
        callId: guardCallId,
        responseId,
        latencyMs,
        ok: result.ok && status !== "block",
        decision: status,
        note,
        alerted: false,
      },
      proofRecord: buildDecisionProofRecord({
        purpose: "radar_guard",
        rubricId: RADAR_VERDICT_RUBRIC_ID,
        status: result.ok && status !== "block" ? "ok" : result.ok && status === "block" ? "error" : "error",
        responseId,
        model: result.proof.modelReported,
        recordedAt: at,
        inputs: guardInputs,
        verdict: result.ok ? status : null,
        detail: result.ok && status !== "block" ? null : note,
      }),
    };
  } catch {
    const note = `SERV timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s`;
    return {
      status: "timeout",
      activity: {
        at,
        searchId,
        vin: "",
        profile: "radar_guard",
        modelRequested: deps.servModel ?? "",
        modelReported: "",
        callId: guardCallId,
        responseId: null,
        latencyMs: timeoutMs,
        ok: false,
        decision: "timeout",
        note,
        alerted: false,
      },
      proofRecord: buildDecisionProofRecord({
        purpose: "radar_guard",
        rubricId: RADAR_VERDICT_RUBRIC_ID,
        status: "error",
        recordedAt: at,
        inputs: guardInputs,
        detail: note,
      }),
    };
  }
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

function httpsFromListing(listing: Listing): string | null {
  for (const raw of [listing.vdp, listing.dealerUrl]) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!/^https:\/\//i.test(trimmed)) continue;
    try {
      const u = new URL(trimmed);
      if (u.protocol === "https:") return u.toString();
    } catch {
      /* skip */
    }
  }
  return null;
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
  status: WatchAlert["status"] = "new",
  proofRecords?: import("@/domain/decision-proof-record").DecisionProofRecord[],
): WatchAlert {
  return {
    id: randomUUID(),
    ownerId: search.ownerId,
    searchId: search.id,
    vin: listing.vin,
    createdAt: iso,
    status,
    mode: search.mode,
    year: listing.year,
    make: listing.make,
    model: listing.model,
    trim: listing.trim,
    priceUsd: listing.priceUsd ?? numbers.priceUsd,
    miles: listing.miles,
    distanceMiles: typeof listing.distanceMiles === "number" ? listing.distanceMiles : null,
    radiusCheck: listing.radiusCheck === "known" ? "known" : "unverified",
    listingUrl: httpsFromListing(listing),
    city: listing.city,
    state: listing.state,
    why,
    numbers,
    sample: listing.source === "sample",
    checks,
    proofRecords: proofRecords?.length ? proofRecords : undefined,
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

function summarizeShadow(notes: string[]): string {
  if (notes.length === 0) return "no_alerts";
  const counts = new Map<string, number>();
  for (const note of notes) counts.set(note, (counts.get(note) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => `${name}:${count}`).join(", ");
}
