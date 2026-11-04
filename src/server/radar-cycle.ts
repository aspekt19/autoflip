import { randomUUID } from "node:crypto";
import { ASSUMPTIONS } from "@/domain/assumptions";
import {
  criteriaKey,
  groupByCriteria,
  intervalHours,
  isDue,
  marketBand,
  mergeSeen,
  prefilterListing,
  rankPasses,
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
import { listSearches, pushRun, saveAlerts, saveSearches, seenVins, storeSeen, telegramChat, type StoredRun, listAlerts } from "./radar-store";

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
};

export async function runRadarCycle(deps: CycleDeps): Promise<StoredRun> {
  const startedAt = deps.now.toISOString();
  const notes: string[] = [];
  const searches = (await listSearches(deps.kv)).filter((item) => item.enabled);
  const groups = groupByCriteria(searches);
  const hours = intervalHours(groups.size || 1);
  const intervalMs = hours * 60 * 60 * 1000;
  let listings = 0;
  let passed = 0;
  let filteredOut = 0;
  let alertsSent = 0;
  let autodevCalls = 0;
  let skippedDue = 0;
  const alerts = await listAlerts(deps.kv);
  const shadowNotes: string[] = [];

  const guardText = searches.map((item) => `${item.name} ${item.mode} ${item.criteria.zip} ${item.criteria.priceMax}`).join("\n");
  const promptGuard = await runGuard(guardText, deps);
  notes.push(`prompt guard: ${promptGuard}`);

  if (promptGuard === "block") {
    const run = finish(deps, startedAt, hours, groups.size, 0, 0, 0, 0, 0, 0, ["Saved criteria were rejected by the input check. No listings call was made."], promptGuard, "not_run");
    await pushRun(deps.kv, run);
    return run;
  }

  if (!deps.autodevKey) {
    notes.push("AUTODEV_API_KEY is not set. No listings were requested and no alerts were invented.");
  }

  for (const [key, group] of groups) {
    const due = deps.forceAll || group.some((item) => isDue(item.lastCheckedAt, deps.now.getTime(), intervalMs));
    if (!due) {
      skippedDue += group.length;
      continue;
    }
    if (!deps.autodevKey) {
      stamp(group, deps.now.toISOString());
      continue;
    }
    const slot = await reserveRadarCall(deps.kv, deps.now);
    if (!slot.ok) {
      notes.push(slot.message);
      break;
    }
    autodevCalls += 1;
    const url = listingsSearchUrl(toListingsQuery(group[0]!.criteria));
    const fetched = await fetchListings(url, deps.autodevKey, deps.fetchImpl);
    if (!fetched.ok) {
      notes.push(fetched.message);
      stamp(group, deps.now.toISOString());
      continue;
    }
    listings += fetched.listings.length;
    const seen = await seenVins(deps.kv, key);
    const fresh = unseenListings(fetched.listings, seen);
    filteredOut += fetched.listings.length - fresh.length;
    const band = marketBand(fetched.listings);
    await storeSeen(deps.kv, key, mergeSeen(seen, fetched.listings.map((item) => item.vin)));

    for (const search of group) {
      const decisions = fresh.map((listing) => ({
        listing,
        decision: prefilterListing(listing, search.criteria, band, search.mode, deps.now.getUTCFullYear()),
      }));
      const winners = rankPasses(
        decisions.flatMap((item) => (item.decision.pass ? [{ listing: item.listing, numbers: item.decision.numbers, why: item.decision.why }] : [])),
      ).slice(0, ASSUMPTIONS.radarMaxAlertsPerSearch);
      const passCount = decisions.filter((item) => item.decision.pass).length;
      filteredOut += decisions.length - passCount;
      passed += passCount;
      for (const winner of winners) {
        const reviewed = await reviewWhy(winner.why, winner.numbers, deps);
        shadowNotes.push(reviewed.source);
        const alert = makeAlert(search, winner.listing, reviewed.why, winner.numbers, deps.now.toISOString());
        alerts.unshift(alert);
        alertsSent += 1;
        const chat = await telegramChat(deps.kv, search.ownerId);
        if (chat && deps.env.TELEGRAM_BOT_TOKEN) {
          await sendTelegram(chat, alert, deps);
        }
      }
      search.lastCheckedAt = deps.now.toISOString();
    }
  }

  await saveSearches(deps.kv, await mergeChecked(deps.kv, searches));
  await saveAlerts(deps.kv, alerts);

  const payment = await payRadarTicket({
    ticketUrl: `${deps.origin}/api/v1/radar-ticket`,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });
  if (!deps.env.TELEGRAM_BOT_TOKEN) notes.push("Telegram is not configured. Alerts stay in the app.");
  const shadow = deps.servKey ? summarizeShadow(shadowNotes) : "not_configured";
  const run = finish(deps, startedAt, hours, groups.size, listings, passed, filteredOut, alertsSent, autodevCalls, skippedDue, notes, promptGuard, shadow, payment);
  await pushRun(deps.kv, run);
  return run;
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
  startedAt: string,
  hours: number,
  uniqueSearches: number,
  listings: number,
  passed: number,
  filteredOut: number,
  alertsSent: number,
  autodevCalls: number,
  skippedDue: number,
  notes: string[],
  promptGuard: string,
  shadow: string,
  payment?: StoredRun["payment"],
): StoredRun {
  return {
    id: randomUUID(),
    startedAt,
    finishedAt: new Date().toISOString(),
    trigger: deps.trigger,
    storage: storageMode(deps.env),
    uniqueSearches,
    intervalHours: hours,
    listings,
    passed,
    filteredOut,
    alertsSent,
    autodevCalls,
    skippedDue,
    notes,
    serv: { promptGuard, shadow },
    payment: payment ?? {
      status: "not_configured",
      missing: [],
      tx: null,
      detail: "Payment step did not run.",
      costAtomic: null,
      network: null,
    },
  };
}

async function runGuard(text: string, deps: CycleDeps): Promise<string> {
  if (!deps.servKey) return "not_configured";
  if (!text.trim()) return "skipped_empty";
  const result = await postServ(buildGuardRequest(text, deps.servModel || "gpt-5.4-mini"), {
    fetch: deps.fetchImpl,
    apiKey: deps.servKey,
    baseUrl: deps.servBaseUrl || "https://inference-api.openserv.ai/v1",
  });
  if (!result.ok) return `error: ${result.error}`;
  return interpretGuard(result.text);
}

async function reviewWhy(why: string, numbers: WatchAlert["numbers"], deps: CycleDeps): Promise<{ why: string; source: string }> {
  if (!deps.servKey) return { why, source: "template" };
  const result = await postServ(buildAlertReviewRequest(why, numbers, deps.servModel || "gpt-5.4-mini"), {
    fetch: deps.fetchImpl,
    apiKey: deps.servKey,
    baseUrl: deps.servBaseUrl || "https://inference-api.openserv.ai/v1",
  });
  if (!result.ok) return { why, source: "template_after_error" };
  const audit = auditExplanation(result.text, fakeReport(numbers, why));
  const failed = result.shadowOutcome === "exhausted" || result.shadowOutcome === "failed";
  if (!audit.ok || failed) return { why, source: failed ? "shadow_rejected" : "audit_rejected" };
  return { why: result.text, source: result.shadowOutcome };
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
          resaleHighUsd: numbers.medianUsd,
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

async function fetchListings(url: string, apiKey: string, fetchImpl: typeof fetch): Promise<{ ok: true; listings: Listing[] } | { ok: false; message: string }> {
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return { ok: false, message: `Listings provider returned ${response.status}.` };
    const json: unknown = await response.json();
    return { ok: true, listings: parseAutoDevListings(json, "autodev") };
  } catch {
    return { ok: false, message: "Listings provider did not respond." };
  }
}

async function sendTelegram(chatId: string, alert: WatchAlert, deps: CycleDeps) {
  const token = deps.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const message = alertMessage({ why: alert.why, origin: deps.origin, alertId: alert.id });
  await deps.fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message.text, reply_markup: message.reply_markup }),
  }).catch(() => undefined);
}

function summarizeShadow(notes: string[]): string {
  if (notes.length === 0) return "no_alerts";
  const counts = new Map<string, number>();
  for (const note of notes) counts.set(note, (counts.get(note) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => `${name}:${count}`).join(", ");
}
