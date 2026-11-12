/**
 * Buyer view of a stored run. Safe to import from client components:
 * it does not touch the search spec builder or Node crypto.
 */
import {
  confidenceCopy,
  failureCopy,
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
};

export type RunStepView = {
  step: JournalStepId;
  status: StepStatus;
  responseId: string | null;
  elapsedMs: number | null;
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
  creditsCharged: number;
  failureReasons: FailureReasonId[];
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

function carTitle(car: RunListingView): string {
  const name = [car.year > 0 ? String(car.year) : "", car.make, car.model, car.trim ?? ""]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  return name || "Vehicle";
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
  const verdictLine = view.verdict ? verdictCopy(view.verdict) : null;
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
    confidenceLine: view.confidence ? `Confidence: ${confidenceCopy(view.confidence)}` : null,
    failureLines: view.failureReasons.map((id) => failureCopy(id)),
    chargeLine,
    note: view.note,
    clarifications: view.clarifications,
    limits: view.limits,
    journal: view.steps.map((step) => journalStepCopy(step.step, step.status)),
    sources: view.sources.map((id) => sourceCopy(id)),
    listings: view.listings.map((car) => {
      const host = car.vdp ? hostOf(car.vdp) : null;
      const place = [car.city, car.state].filter(Boolean).join(", ") || null;
      return {
        ...car,
        title: carTitle(car),
        place,
        linkLabel: host ? `Listing on ${host}` : car.vdp ? "Dealer listing" : null,
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
  if (model.confidenceLine) parts.push(`<p>${esc(model.confidenceLine)}</p>`);
  for (const line of model.failureLines) parts.push(`<p>${esc(line)}</p>`);
  parts.push(`<p>${esc(model.chargeLine)}</p>`);
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
    parts.push(`<h2>${esc(car.title)}</h2>`);
    if (car.dealer) parts.push(`<p>${esc(car.dealer)}</p>`);
    if (car.vdp && car.linkLabel) parts.push(`<a href="${esc(car.vdp)}">${esc(car.linkLabel)}</a>`);
    parts.push("</section>");
  }
  if (model.viewerIsOwner) {
    parts.push(`<form data-owner-action="add-detail"><button type="submit">Add a detail</button></form>`);
  }
  parts.push(`<details class="technical-details"><summary>Technical details</summary>`);
  for (const id of model.technicalIds) parts.push(`<p class="response-id">${esc(id)}</p>`);
  parts.push("</details>");
  parts.push("</article>");
  return parts.join("");
}
