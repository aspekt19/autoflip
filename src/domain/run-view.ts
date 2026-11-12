/**
 * Buyer view of a stored run. Safe to import from client components:
 * it does not touch the search spec builder or Node crypto.
 */
import { joinBuyerParts } from "./buyer-text";
import { veryHighMileageLabel } from "./find-best-deal";
import { resaleEdgeSentence, resalePickHeading } from "./resale-presentation";
import { buyerTrim } from "./buyer-trim";
import {
  confidenceCopy,
  failureCopy,
  JOURNAL_STEP_IDS,
  journalStepCopy,
  kindCopy,
  phaseCopy,
  sourceCopy,
  verdictCopy,
  type FailureReasonId,
  type JournalStepId,
  type RunConfidence,
  type RunKind,
  type RunPhase,
  type SourceId,
  type StepStatus,
  type VerdictId,
} from "./buyer-copy-table";

export type RunListingView = {
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  priceUsd: number | null;
  miles: number | null;
  dealer: string | null;
  vdp: string | null;
  city: string | null;
  state: string | null;
  /** Resale: this row is the chosen flip. */
  picked?: boolean;
  /** Plain resale line, such as the price gap after costs. */
  summary?: string | null;
  drivetrain?: string | null;
  accidentCount?: number | null;
  bodyStyle?: string | null;
  offerUsd?: number | null;
  offerLabel?: string | null;
  reason?: string | null;
  confidence?: string | null;
  implausible?: boolean;
  drivetrainUnknown?: boolean;
  bodyUnknown?: boolean;
};

export type RunStepView = {
  step: JournalStepId;
  status: StepStatus;
  responseId: string | null;
  elapsedMs: number | null;
  /** Plain reason this step failed. Empty when the step finished. */
  failureDetail?: string | null;
};

export type RunView = {
  id: string;
  kind: RunKind;
  phase: RunPhase;
  viewerIsOwner: boolean;
  permalink: string;
  note: string;
  clarifications: string[];
  limits: string[];
  verdict: VerdictId | null;
  confidence: RunConfidence | null;
  confidenceReason: string | null;
  creditsCharged: number;
  failureReasons: FailureReasonId[];
  buyerMessage: string | null;
  steps: RunStepView[];
  sources: SourceId[];
  listings: RunListingView[];
  picks: string[];
};

export type RunReportModel = {
  kicker: string;
  title: string;
  phaseLine: string;
  verdictLine: string | null;
  confidenceLine: string | null;
  failureLines: string[];
  chargeLine: string;
  buyerMessage: string | null;
  note: string;
  clarifications: string[];
  limits: string[];
  journal: { title: string; sentence: string }[];
  sources: string[];
  listings: Array<RunListingView & { title: string; place: string | null; linkLabel: string | null }>;
  permalink: string;
  technicalIds: string[];
  viewerIsOwner: boolean;
};

function resaleVerdictLine(view: RunView): string | null {
  if (view.kind === "resale" && view.failureReasons.includes("no_qualifying_flip")) return "Skip";
  if (!view.verdict) return null;
  if (view.kind === "resale" && view.verdict === "pass") return "Pass";
  return verdictCopy(view.verdict);
}

function carTitle(car: RunListingView): string {
  const name = [car.year > 0 ? String(car.year) : "", car.make, car.model, buyerTrim(car.trim)]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  return name || "Vehicle";
}

export function pickHeading(view: RunView, picked: boolean): string | null {
  if (!picked) return null;
  if (view.kind === "resale") return resalePickHeading(view.verdict, true);
  if (view.verdict) return verdictCopy(view.verdict);
  return null;
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function hostOf(href: string): string | null {
  try {
    return new URL(href).hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

export function runReportModel(view: RunView): RunReportModel {
  const lead = view.listings[0] ? carTitle(view.listings[0]) : kindCopy(view.kind);
  const title = view.listings.length === 1 ? lead : view.listings.length > 1 ? `${view.listings.length} cars` : lead;
  const orderedSteps = [...view.steps].sort(
    (a, b) => JOURNAL_STEP_IDS.indexOf(a.step) - JOURNAL_STEP_IDS.indexOf(b.step),
  );
  const journal = orderedSteps.map((step) => {
    const copy = journalStepCopy(step.step, step.status);
    const detail = step.failureDetail?.trim();
    if (step.status !== "failed" || !detail || copy.sentence.includes(detail)) return copy;
    const sentence = /[.!?]$/.test(copy.sentence.trim()) ? copy.sentence.trim() : `${copy.sentence.trim()}.`;
    return { ...copy, sentence: `${sentence} ${detail}` };
  });
  const journalSentences = new Set([
    ...journal.map((step) => step.sentence),
    ...orderedSteps.map((step) => journalStepCopy(step.step, step.status).sentence),
  ]);
  const verdictLine = resaleVerdictLine(view);
  const confidenceText = view.confidenceReason?.trim() || (view.confidence ? `Confidence: ${confidenceCopy(view.confidence)}` : "");
  const messageText = view.buyerMessage?.trim() ?? "";
  const confidenceRepeatsMessage =
    Boolean(messageText) &&
    Boolean(confidenceText) &&
    (messageText.toLowerCase().includes(confidenceText.toLowerCase()) || confidenceText.toLowerCase().includes(messageText.toLowerCase()));
  const chargeLine =
    view.creditsCharged > 0
      ? view.creditsCharged === 1
        ? "1 credit was used."
        : `${view.creditsCharged} credits were used.`
      : "No credit was used.";
  return {
    kicker: kindCopy(view.kind),
    title,
    phaseLine: phaseCopy(view.phase),
    verdictLine,
    confidenceLine: view.confidence && !confidenceRepeatsMessage ? confidenceText : null,
    failureLines: view.failureReasons
      .map((id) => failureCopy(id))
      .filter((line) => !journalSentences.has(line))
      .filter((line) => !messageText.toLowerCase().includes(line.toLowerCase())),
    chargeLine,
    buyerMessage: view.buyerMessage,
    note: view.note,
    clarifications: view.clarifications,
    limits: view.limits,
    journal,
    sources: view.sources.map((id) => sourceCopy(id)),
    listings: view.listings.map((car) => {
      const host = car.vdp ? hostOf(car.vdp) : null;
      const place = [car.city, car.state].filter(Boolean).join(", ") || null;
      const mileageFlag = veryHighMileageLabel(car.miles);
      return {
        ...car,
        title: carTitle(car),
        place,
        linkLabel: host ? `Listing on ${host}` : car.vdp ? "Dealer listing" : null,
        summary:
          joinBuyerParts([
            car.summary,
            car.reason,
            car.offerLabel,
            mileageFlag,
          ]) || null,
      };
    }),
    permalink: view.permalink,
    technicalIds: view.steps.map((step) => step.responseId).filter((id): id is string => Boolean(id)),
    viewerIsOwner: view.viewerIsOwner,
  };
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Permalink HTML. Response ids sit only inside Technical details. */
export function renderRunPermalinkHtml(view: RunView): string {
  const model = runReportModel(view);
  const parts: string[] = [`<article class="run-report">`];
  parts.push(`<p class="kicker">${esc(model.kicker)}</p>`);
  parts.push(`<h1>${esc(model.title)}</h1>`);
  parts.push(`<p>${esc(model.phaseLine)}</p>`);
  if (model.verdictLine) parts.push(`<p class="verdict-level">Verdict: ${esc(model.verdictLine)}</p>`);
  if (view.buyerMessage) parts.push(`<p>${esc(view.buyerMessage)}</p>`);
  if (model.confidenceLine) parts.push(`<p>${esc(model.confidenceLine)}</p>`);
  for (const line of model.failureLines) parts.push(`<p>${esc(line)}</p>`);
  const chargeAlreadySaid = Boolean(
    view.buyerMessage &&
      /no credit was used|nothing was charged|no charge/i.test(view.buyerMessage) &&
      /no credit was used/i.test(model.chargeLine),
  );
  if (!chargeAlreadySaid) parts.push(`<p>${esc(model.chargeLine)}</p>`);
  if (model.note) parts.push(`<p>${esc(model.note)}</p>`);
  if (model.clarifications.length) {
    parts.push("<ul>");
    for (const line of model.clarifications) parts.push(`<li>${esc(line)}</li>`);
    parts.push("</ul>");
  }
  if (model.limits.length) {
    parts.push("<ul>");
    for (const line of model.limits) parts.push(`<li>${esc(line)}</li>`);
    parts.push("</ul>");
  }
  if (model.journal.length) {
    parts.push(`<ol class="serv-decision-journal">`);
    for (const step of model.journal) {
      parts.push(`<li><strong>${esc(step.title)}</strong> ${esc(step.sentence)}</li>`);
    }
    parts.push("</ol>");
  }
  if (model.sources.length) {
    parts.push("<ul>");
    for (const source of model.sources) parts.push(`<li>${esc(source)}</li>`);
    parts.push("</ul>");
  }
  for (const car of model.listings) {
    parts.push(`<section data-vin="${esc(car.vin)}">`);
    const heading = pickHeading(view, Boolean(car.picked));
    if (heading) parts.push(`<p class="run-pick-label">${esc(heading)}</p>`);
    parts.push(`<h2 class="run-car-title">${esc(car.title)}</h2>`);
    if (car.summary) parts.push(`<p>${esc(car.summary)}</p>`);
    const facts = [
      car.priceUsd == null ? "Price not listed" : money(car.priceUsd),
      car.miles == null ? null : `${car.miles.toLocaleString("en-US")} miles`,
      car.drivetrain ? car.drivetrain : car.drivetrainUnknown ? "Drivetrain not listed" : null,
      car.place,
    ].filter(Boolean);
    if (facts.length) parts.push(`<p>${esc(facts.join(" · "))}</p>`);
    if (car.dealer) parts.push(`<p>${esc(car.dealer)}</p>`);
    if (car.vdp && car.linkLabel) parts.push(`<a href="${esc(car.vdp)}">${esc(car.linkLabel)}</a>`);
    parts.push("</section>");
  }
  if (model.viewerIsOwner) {
    parts.push(`<form data-owner-action="add-detail"><button type="submit">Add a detail</button></form>`);
  }
  parts.push(`<details class="technical-details"><summary>Reference codes</summary>`);
  for (const id of model.technicalIds) parts.push(`<p class="response-id">${esc(id)}</p>`);
  parts.push("</details>");
  parts.push("</article>");
  return parts.join("");
}
