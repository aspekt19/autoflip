/**
 * I1–I10 from docs/STABILIZATION.md §5.
 * Price uses the documented 5% slight-over rule (src/domain/budget.ts).
 */
import { formatOfficialRecallNumber } from "@/domain/find-buyer-copy";
import { checkRunInvariants } from "@/domain/run-invariants";
import { AGGREGATOR_HOSTS } from "@/domain/listing-vdp-verifiability";
import { computedProvenance } from "@/domain/resale-provenance";
import type { GoldenCase } from "./cases";
import type { CheckFailure, GoldenRun, ObservedSpec, ShownListing } from "./types";

/** Buyer-facing HTML must not contain these. Response ids are removed first. */
export const I6_FORBIDDEN =
  /chatcmpl-|inputs digest|providerQueriesUsed|FIND_[A-Z_]+|serv_[a-z_]+|needs_inspection|evaluateListingPrice|sellFriction|idempotency|pnl:|\{"|checkId|Pool empty/;

const VERDICTS = new Set(["buy", "negotiate", "pass", "skip", "needs_inspection"]);

export function priceCeil(budgetUsd: number): number {
  return budgetUsd * 1.05;
}

export function yearWindow(param: string | null): { lo: number | null; hi: number | null } {
  if (!param) return { lo: null, hi: null };
  const range = param.match(/^(\d{4})-(\d{4})$/);
  if (range) return { lo: Number(range[1]), hi: Number(range[2]) };
  if (/^\d{4}$/.test(param)) {
    const year = Number(param);
    return { lo: year, hi: year };
  }
  return { lo: null, hi: null };
}

function listingParam(url: string, key: string): string | null {
  try {
    return new URL(url).searchParams.get(key);
  } catch {
    return null;
  }
}

function money(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

function hostOf(href: string): string | null {
  try {
    return new URL(href).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function isAwd(value: string | null): boolean {
  return Boolean(value && /\b(awd|4wd|4x4|all[-\s]?wheel|four[-\s]?wheel)\b/i.test(value));
}

function specValue<T>(spec: ObservedSpec, key: keyof ObservedSpec["hard"]): T | undefined {
  const row = spec.hard[key] as { value: T } | undefined;
  return row?.value;
}

function noteHasNumber(note: string, value: number): boolean {
  const digits = String(value);
  if (note.includes(digits)) return true;
  const k = value / 1000;
  if (Number.isInteger(k) && new RegExp(`\\b${k}\\s*k\\b`, "i").test(note)) return true;
  if (Number.isInteger(k) && new RegExp(`\\b${k}\\s*grand\\b`, "i").test(note)) return true;
  return false;
}

export function sharedHardFields(prev: ObservedSpec, next: ObservedSpec, note: string, dirty: ReadonlySet<string>): string[] {
  const keys = ["priceMaxUsd", "yearMin", "yearMax", "milesMax", "zip", "radiusMi", "drivetrain", "excludeMakes"] as const;
  const shared: string[] = [];
  for (const key of keys) {
    const a = prev.hard[key];
    const b = next.hard[key];
    if (!a || !b) continue;
    if (JSON.stringify(a.value) !== JSON.stringify(b.value)) continue;
    if (dirty.has(key)) continue;
    if (key === "priceMaxUsd" && typeof b.value === "number" && noteHasNumber(note, b.value)) continue;
    if ((key === "yearMin" || key === "yearMax") && typeof b.value === "number" && note.includes(String(b.value))) continue;
    if (key === "zip" && typeof b.value === "string" && note.includes(b.value)) continue;
    shared.push(key);
  }
  return shared;
}

function push(out: CheckFailure[], id: string, message: string) {
  out.push({ id, message });
}

function checkListings(run: GoldenRun, expect: GoldenCase["expect"], out: CheckFailure[]) {
  const budget = expect.budgetUsd;
  const ceil = expect.priceCeilUsd ?? (budget != null ? priceCeil(budget) : null);
  for (const car of run.listings) {
    if (ceil != null && (car.priceUsd == null || car.priceUsd > ceil)) {
      push(out, "I1.price", `${car.vin} price ${car.priceUsd ?? "missing"} is above ${ceil} (budget × 1.05).`);
    }
    if (expect.yearMin != null && car.year < expect.yearMin) {
      push(out, "I1.year", `${car.vin} is ${car.year}, older than ${expect.yearMin}.`);
    }
    if (expect.milesMax != null && (car.miles == null || car.miles > expect.milesMax)) {
      push(out, "I1.miles", `${car.vin} miles ${car.miles ?? "missing"} exceed ${expect.milesMax}.`);
    }
    if (expect.radiusMi != null && car.distanceMiles != null && car.distanceMiles > expect.radiusMi) {
      push(out, "I1.distance", `${car.vin} is ${car.distanceMiles} mi, past radius ${expect.radiusMi}.`);
    }
    if (expect.excludeMakes?.some((make) => make.toLowerCase() === car.make.toLowerCase())) {
      push(out, "I1.make", `${car.vin} is a ${car.make}, which the note excluded.`);
    }
    if (expect.drivetrain === "awd_4wd" && !isAwd(car.drivetrain) && !car.drivetrainUnknownFlagged) {
      push(out, "I1.drivetrain", `${car.vin} drivetrain ${car.drivetrain ?? "blank"} is not AWD/4WD and is not flagged unknown.`);
    }
    if (expect.accidents === "none_or_flagged") {
      if (car.accidentCount == null && !car.accidentUnknownFlagged) {
        push(out, "I1.accidents", `${car.vin} has no accident count and is not flagged unknown.`);
      } else if (car.accidentCount != null && car.accidentCount > 0) {
        push(out, "I1.accidents", `${car.vin} shows ${car.accidentCount} accidents.`);
      }
    }
    if (expect.seatsMin != null && (car.seats == null || car.seats < expect.seatsMin) && !car.seatsUnknownFlagged) {
      push(out, "I1.seats", `${car.vin} seats ${car.seats ?? "missing"} are under ${expect.seatsMin} and not flagged.`);
    }
    if (expect.models && !expect.models.some((model) => model.toLowerCase() === car.model.toLowerCase())) {
      push(out, "G5.models", `${car.vin} model ${car.model} is outside ${expect.models.join(", ")}.`);
    }
  }
}

function checkQueries(run: GoldenRun, expect: GoldenCase["expect"], out: CheckFailure[]) {
  if (expect.yearMin == null) return;
  if (run.listingUrls.length === 0) {
    push(
      out,
      "I1.year",
      `Year floor ${expect.yearMin} was not enforced: inventory was not asked for a year window (no post-filter).`,
    );
    return;
  }
  for (const url of run.listingUrls) {
    const window = yearWindow(listingParam(url, "vehicle.year"));
    if (window.lo == null || window.lo < expect.yearMin) {
      push(
        out,
        "I1.year",
        `Inventory request year ${listingParam(url, "vehicle.year") ?? "unset"} does not enforce ≥ ${expect.yearMin} (no post-filter).`,
      );
      return;
    }
  }
}

function checkMilesQuery(run: GoldenRun, expect: GoldenCase["expect"], out: CheckFailure[]) {
  if (expect.milesMax == null || run.listingUrls.length === 0) return;
  for (const url of run.listingUrls) {
    const raw = listingParam(url, "retailListing.miles");
    const hi = raw?.match(/-(\d+)$/)?.[1];
    if (!hi || Number(hi) > expect.milesMax) {
      push(out, "I1.miles", `Inventory miles window ${raw ?? "unset"} does not enforce ≤ ${expect.milesMax}.`);
      return;
    }
  }
}

function checkPriceQuery(run: GoldenRun, expect: GoldenCase["expect"], out: CheckFailure[]) {
  if (expect.priceCeilUsd == null || run.listingUrls.length === 0) return;
  for (const url of run.listingUrls) {
    const raw = listingParam(url, "retailListing.price");
    const hi = raw?.match(/-(\d+)$/)?.[1];
    if (!hi || Number(hi) > expect.priceCeilUsd) {
      push(
        out,
        "I1.price",
        `Inventory price window ${raw ?? "unset"} allows more than ${money(expect.priceCeilUsd)}.`,
      );
      return;
    }
  }
}

function checkI2(run: GoldenRun, expect: GoldenCase["expect"], out: CheckFailure[]) {
  if (expect.budgetUsd == null) return;
  const spec = run.specs[run.specs.length - 1];
  if (!spec) {
    push(out, "I2", "No spec was recorded.");
    return;
  }
  const got = specValue<number>(spec, "priceMaxUsd");
  const source = spec.hard.priceMaxUsd?.source ?? "missing";
  if (got !== expect.budgetUsd) {
    push(
      out,
      "I2",
      `Budget is ${got ?? "missing"} (source ${source}); the note or dirty form states ${money(expect.budgetUsd)}.`,
    );
  }
}

function checkI3(run: GoldenRun, specCase: GoldenCase, out: CheckFailure[]) {
  if (specCase.kind !== "sequence") return;
  for (let i = 1; i < run.specs.length; i += 1) {
    const prev = run.specs[i - 1]!;
    const next = run.specs[i]!;
    const dirty = new Set<string>();
    if (specCase.location !== "from-note" && specCase.location !== "nationwide") {
      dirty.add("zip");
      dirty.add("radiusMi");
    }
    const shared = sharedHardFields(prev, next, next.note, dirty);
    if (shared.length > 0) {
      push(
        out,
        "I3",
        `Spec ${i + 1} keeps ${shared.join(", ")} from the previous search, and that value is not in the new note or a dirty form field.`,
      );
    }
  }
  if (run.idempotencyKeys.length >= 2) {
    const [first, second] = run.idempotencyKeys;
    if (first === second) {
      push(out, "G9.idempotency", "The second search reused the first idempotency key.");
    }
  }
  if (run.replayedPriorDelivery) {
    push(out, "G9.idempotency", "The second search replayed the previous delivery.");
  }
}

function checkI4(run: GoldenRun, out: CheckFailure[]) {
  const hash = run.specs[run.specs.length - 1]?.hash;
  if (!hash) return;
  const tagged = run.proofRecords.filter((row) => typeof row.specHash === "string");
  if (tagged.length === 0) return;
  for (const row of run.proofRecords) {
    if (row.specHash !== hash) {
      push(out, "I4", `Proof ${row.purpose ?? "step"} specHash ${row.specHash ?? "missing"} ≠ run spec ${hash}.`);
    }
  }
}

function checkI5(run: GoldenRun, out: CheckFailure[]) {
  const verdict = (run.verdict ?? "").toLowerCase();
  const hasVerdict = VERDICTS.has(verdict);
  if (run.providerQueriesUsed > 0) return;
  if (run.status === "stopped" && !run.charged && !hasVerdict) return;
  if (hasVerdict) {
    push(
      out,
      "I5",
      `Verdict ${run.verdict} with providerQueriesUsed = 0. A verdict needs a real inventory query, or the run must stop with no charge.`,
    );
    return;
  }
  push(out, "I5", "providerQueriesUsed is 0 and the run did not stop with no charge.");
}

export function buyerHtmlForScan(html: string): string {
  return html.replace(/<details\b[^>]*class="technical-details"[\s\S]*?<\/details>/gi, "");
}

function checkI6(html: string, out: CheckFailure[]) {
  const buyer = buyerHtmlForScan(html);
  const match = buyer.match(I6_FORBIDDEN);
  if (match) push(out, "I6", `Buyer HTML contains internal text “${match[0]}”.`);
  const outside = buyer.includes("chatcmpl-") || buyer.includes("resp_");
  if (outside) push(out, "I6", "A response id appears outside Technical details.");
}

function checkI7(run: GoldenRun, out: CheckFailure[]) {
  if (run.recordingsPending) return;
  const failed = run.proofRecords.filter((row) => row.status && row.status !== "ok" && row.status !== "skipped");
  if (failed.length === 0) return;
  if (run.confidence !== "Low") {
    push(out, "I7", `A step was not ok (${failed.map((row) => row.purpose).join(", ")}) but confidence is ${run.confidence ?? "missing"}.`);
  }
  const blob = `${run.buyer.headline ?? ""} ${run.buyer.message ?? ""} ${run.buyer.journal.join(" ")}`.toLowerCase();
  if (!/could not|did not finish|unavailable|not configured|no credit/.test(blob)) {
    push(out, "I7", "A SERV step failed and the buyer copy does not name the missing step.");
  }
  const critical = failed.some((row) => row.purpose === "find_plan" || row.purpose === "find_decide" || /plan|decide/.test(row.purpose ?? ""));
  if (critical && run.charged) {
    push(out, "I7", "A critical step failed and the run still charged.");
  }
}

function checkI8(run: GoldenRun, html: string, out: CheckFailure[]) {
  for (const car of run.listings) {
    if (!car.vdp) continue;
    const host = hostOf(car.vdp);
    if (!host) {
      push(out, "I8", `${car.vin} dealer link is not a URL.`);
      continue;
    }
    const aggregator = AGGREGATOR_HOSTS.has(host);
    const labelled = html.includes(host);
    if (aggregator && !labelled) {
      push(out, "I8", `${car.vin} links to ${host} without labelling that host.`);
    }
    if (car.dealer && !html.includes(car.dealer)) {
      push(out, "I8", `${car.vin} dealer name is not in the rendered card.`);
    }
    if (!html.includes(car.vdp)) {
      push(out, "I8", `${car.vin} href is not the listing's own VDP.`);
    }
  }
}

function checkI9(a: GoldenRun, b: GoldenRun, out: CheckFailure[]) {
  const left = JSON.stringify(a.final);
  const right = JSON.stringify(b.final);
  if (left !== right) {
    push(out, "I9", `Replay diverged. First ${left}. Second ${right}.`);
  }
}

function checkI10(run: GoldenRun, mode: "replay" | "record" | "live", out: CheckFailure[]) {
  if (mode === "replay" && run.elapsedMs >= 5_000) {
    push(out, "I10", `Replay took ${run.elapsedMs} ms (limit 5000).`);
  }
  if (mode !== "live") return;
  for (const step of run.steps) {
    if (step.status === "timeout" && step.profileTimeoutMs != null && step.elapsedMs < step.profileTimeoutMs) {
      push(
        out,
        "I10",
        `${step.name} timed out at ${step.elapsedMs} ms, under its profile timeout ${step.profileTimeoutMs} ms.`,
      );
    }
  }
}

function checkCase(run: GoldenRun, specCase: GoldenCase, out: CheckFailure[]) {
  const expect = specCase.expect;
  if (expect.noMilesMax && run.specs.at(-1)?.hard.milesMax) {
    push(out, `${specCase.id}.miles`, "A bare max Nk was also stored as a mileage cap.");
  }
  if (expect.noVerdictWhenEmpty && run.listings.length === 0) {
    if (run.verdict) push(out, `${specCase.id}.verdict`, `Empty search still has verdict ${run.verdict}.`);
    if (run.charged) push(out, `${specCase.id}.charge`, "Empty search debited a credit.");
    if (run.storedRun?.verdict) push(out, `${specCase.id}.verdict`, "Stored run has a verdict with no cars.");
    if (run.storedRun && run.storedRun.creditsCharged !== 0) {
      push(out, `${specCase.id}.charge`, "Stored run charged with no cars.");
    }
  }
  if (expect.queriesRequired && run.providerQueriesUsed <= 0) {
    push(out, `${specCase.id}.queries`, "providerQueriesUsed is 0.");
  }
  if (expect.minModels != null) {
    const models = new Set(
      run.listingUrls.map((url) => listingParam(url, "vehicle.model")?.toLowerCase()).filter((model): model is string => Boolean(model)),
    );
    if (models.size < expect.minModels) {
      push(out, `${specCase.id}.models`, `Only ${models.size} models were searched (${[...models].join(", ")}). A first car needs a broader set.`);
    }
  }
  if (expect.includesModel) {
    const found = run.listings.some((car) => car.model.toLowerCase() === expect.includesModel!.toLowerCase());
    if (!found) push(out, `${specCase.id}.models`, `No ${expect.includesModel} in the results.`);
  }
  if (expect.excludeUnknownDrivetrain) {
    const blank = run.listings.filter((car) => !car.drivetrain?.trim());
    if (blank.length > 0) {
      push(out, `${specCase.id}.drivetrain`, `Unknown drivetrain stayed in the results: ${blank.map((car) => car.vin).join(", ")}.`);
    }
  }
  if (expect.pickVin && run.pickVin !== expect.pickVin) {
    push(out, `${specCase.id}.rank`, `Pick is ${run.pickVin ?? "none"}; expected ${expect.pickVin}.`);
  }
  if (specCase.kind === "personal" && run.storedRun) {
    if (/No flip worth it here|Closest candidate, not worth it|Best flip/i.test(run.storedRun.permalinkHtml)) {
      push(out, `${specCase.id}.heading`, "A Find result uses a resale heading.");
    }
  }
  if (expect.flagVeryHighMiles && run.storedRun) {
    const high = run.listings.filter((car) => (car.miles ?? 0) >= 160_000);
    if (high.length === 0) push(out, `${specCase.id}.miles`, "No very high mileage car was in the results.");
    if (!/Very high mileage/i.test(run.storedRun.permalinkHtml)) {
      push(out, `${specCase.id}.miles`, "Very high mileage cars are not flagged.");
    }
  }
  if (specCase.id === "L23" && run.storedRun) {
    if (!/Illinois/i.test(run.storedRun.permalinkHtml)) {
      push(out, "L23.tax", "A Hammond, IN car in a Chicago search does not say sales tax assumes Illinois.");
    }
  }
  if (expect.passIsNotAFlip && run.storedRun) {
    const html = run.storedRun.permalinkHtml;
    const verdict = (run.verdict ?? "").toLowerCase();
    if (verdict === "pass" || verdict === "skip") {
      if (/Best flip/i.test(html)) push(out, `${specCase.id}.story`, "A pass result still has a Best flip heading.");
      if (!/No flip worth it here/i.test(html)) {
        push(out, `${specCase.id}.story`, "A pass result does not say no flip is worth it here.");
      }
    }
    const blob = `${html} ${run.buyer.message ?? ""}`;
    if (/\$16\b/.test(blob) && /deal|best flip/i.test(blob)) {
      push(out, `${specCase.id}.edge`, "A $16 gap is framed as a deal.");
    }
  }
  if (specCase.id === "L7") {
    const recall = formatOfficialRecallNumber("19V007000");
    if (/\b19V007000\b/.test(recall) && /look this up in the government recall database/i.test(recall)) {
      push(out, "L7.copy", "The recall campaign number is still the main line with a repeated lookup instruction.");
    }
    if (/Computed:|profitMid \/ allInCost|no computed is available|Free public checks and SERV decide finished/i.test(
      `${recall} ${computedProvenance("ROI", "1%", "Expected profit divided by the all-in cost.").source}`,
    )) {
      push(out, "L7.copy", "A buyer-facing template still has a broken or internal label.");
    }
  }
  if (specCase.id === "L8") {
    if (run.confidence !== "Low") {
      push(out, "L8.confidence", `A skipped second check left confidence at ${run.confidence ?? "missing"}.`);
    }
    const blob = `${run.buyer.message ?? ""} ${run.buyer.journal.join(" ")}`;
    if (!/second|review/i.test(blob) || !/low/i.test(blob)) {
      push(out, "L8.confidence", "The skipped review is not explained, or confidence is not said to be Low.");
    }
  }
  if (specCase.id === "G1" && (run.verdict ?? "").toLowerCase() === "pass" && run.providerQueriesUsed <= 0) {
    push(out, "G1.verdict", "Pass with zero provider queries.");
  }
  if (expect.yearMin != null) {
    const enforced = run.specs.at(-1)?.enforced.yearMin;
    if (enforced == null || enforced < expect.yearMin) {
      const id = specCase.id === "G2" ? "G2.year" : "I1.year";
      push(out, id, `Enforced year floor is ${enforced ?? "none"}; the requirement is ${expect.yearMin}.`);
    }
  }
  if (expect.zip !== undefined) {
    const zip = run.specs.at(-1)?.hard.zip;
    if ((zip?.value ?? null) !== expect.zip) {
      push(out, "G6.zip", `ZIP is ${zip?.value ?? "missing"}; expected ${expect.zip ?? "none"}.`);
    } else if (expect.zipSource && zip && zip.source !== expect.zipSource) {
      push(out, "G6.zip", `ZIP ${zip.value} source is ${zip.source}; expected ${expect.zipSource}.`);
    }
  }
  if (expect.radiusMi === null) {
    const radius = run.specs.at(-1)?.enforced.radiusMi;
    if (radius != null) push(out, "G10.radius", `Radius is ${radius}; Nationwide must stay null.`);
    for (const url of run.listingUrls) {
      if (listingParam(url, "distance")) {
        push(out, "G10.radius", "A nationwide search sent a distance parameter.");
        break;
      }
    }
  }
  if (expect.fuel === "hybrid" && run.fuelPreference !== "hybrid") {
    push(out, "G8.fuel", `Fuel preference is ${run.fuelPreference ?? "unset"}; the note asked for a hybrid.`);
  }
  if (expect.towing === "unknown") {
    const blob = `${run.buyer.headline ?? ""} ${run.buyer.message ?? ""} ${run.buyer.journal.join(" ")}`;
    if (/\b(can tow|towing capacity|tow rating)\b/i.test(blob) && !/unknown/i.test(blob)) {
      push(out, "G2.towing", "The result claims a towing number. Towing should stay unknown.");
    }
  }
  if (expect.resaleMilesCeil != null) {
    const pick = run.listings.find((car) => car.vin === run.pickVin) ?? run.listings[0];
    if (pick && pick.miles != null && pick.miles > expect.resaleMilesCeil) {
      push(out, "G4.miles", `Pick ${pick.vin} has ${pick.miles.toLocaleString("en-US")} miles, over ${expect.resaleMilesCeil.toLocaleString("en-US")}.`);
    }
    const ceiling = run.specs.at(-1)?.enforced.milesMax;
    if (ceiling == null || ceiling > expect.resaleMilesCeil) {
      push(
        out,
        "G4.miles",
        `No miles ceiling ≤ ${expect.resaleMilesCeil.toLocaleString("en-US")} (a 303k-mile car is still eligible).`,
      );
    }
  }
  if (expect.asIsReconZero) {
    const pick = run.listings.find((car) => car.vin === run.pickVin) ?? null;
    if (!pick || pick.reconUsd !== 0) {
      push(out, "G4.recon", `As-is should force recon to 0; got ${pick?.reconUsd ?? "no as-is path"}.`);
    }
  }
  if (expect.sellWithinDays != null) {
    const pick = run.listings.find((car) => car.vin === run.pickVin) ?? null;
    if (pick && pick.estimatedDaysToSell != null && pick.estimatedDaysToSell > expect.sellWithinDays && !pick.daysFlagged) {
      push(out, "G4.days", `${pick.estimatedDaysToSell} days to sell is over ${expect.sellWithinDays} and was not flagged.`);
    }
    if (!pick) {
      push(out, "G4.days", `“Sell within ${expect.sellWithinDays} days” was not applied to the search.`);
    }
  }
  if (expect.noDefaultTarget && run.appliedTargetProfitUsd != null) {
    push(out, "G4.target", `A target of ${money(run.appliedTargetProfitUsd)} was applied though the buyer set none.`);
  }
  if (specCase.id === "G10" && run.verdict) {
    const blob = `${run.buyer.headline ?? ""} ${run.buyer.message ?? ""}`.toLowerCase();
    if (run.confidence !== "Low" && !/low confidence|not enough|thin|uncertain/.test(blob)) {
      push(out, "G10.confidence", `Nationwide $5,000 search confidence is ${run.confidence ?? "missing"}, not an honest Low.`);
    }
  }
  const nonHybrid = run.listings.filter((car) => car.fuel && !/hybrid/i.test(car.fuel));
  if (expect.fuel === "hybrid" && nonHybrid.length > 0) {
    push(out, "G8.fuel", `Non-hybrid listings shown: ${nonHybrid.map((car) => car.vin).join(", ")}.`);
  }
}

export function assertInvariants(input: {
  run: GoldenRun;
  again?: GoldenRun;
  specCase: GoldenCase;
  html: string;
  mode: "replay" | "record" | "live";
}): CheckFailure[] {
  const out: CheckFailure[] = [];
  const { run, specCase, html, mode } = input;
  if (run.unseenRequest) {
    push(out, "transport.unseen", "Replay saw a request hash that is not in this case's recordings.");
  }
  checkListings(run, specCase.expect, out);
  checkQueries(run, specCase.expect, out);
  checkMilesQuery(run, specCase.expect, out);
  checkPriceQuery(run, specCase.expect, out);
  checkI2(run, specCase.expect, out);
  checkI3(run, specCase, out);
  checkI4(run, out);
  checkI5(run, out);
  checkI6(html, out);
  if (run.storedRun) {
    if (!run.storedRun.finalMatchesProgress) {
      push(out, "U5.progress", "The stored run's final state does not equal the last in-progress snapshot plus the decision.");
    }
    if (run.listings.length === 0 && run.storedRun.verdict) {
      push(out, "U5.verdict", "No cars were found, but the stored run still has a verdict.");
    }
    if (run.listings.length === 0 && run.storedRun.creditsCharged !== 0) {
      push(out, "U5.charge", "No cars were found, but the stored run still charged a credit.");
    }
    checkI6(run.storedRun.permalinkHtml, out);
    if (run.storedRun.publicRun) {
      const report = checkRunInvariants(run.storedRun.publicRun, run.storedRun.permalinkHtml);
      for (const item of report.checks) {
        if (!item.pass) push(out, `R.${item.id}`, item.message);
      }
    }
  }
  checkI7(run, out);
  checkI8(run, html, out);
  if (mode === "replay" && input.again) checkI9(run, input.again, out);
  checkI10(run, mode, out);
  checkCase(run, specCase, out);
  return dedupe(out);
}

function dedupe(rows: CheckFailure[]): CheckFailure[] {
  const seen = new Set<string>();
  const out: CheckFailure[] = [];
  for (const row of rows) {
    const key = `${row.id}\0${row.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function fuelPreferenceRecorded(listings: readonly ShownListing[], note: string): boolean {
  return /hybrid/i.test(note) && listings.every((car) => !car.fuel || /hybrid/i.test(car.fuel));
}
