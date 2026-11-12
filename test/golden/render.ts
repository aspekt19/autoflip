/**
 * Buyer HTML for I6 / I8. Uses the same consumer proof lines and journal scrub
 * the UI uses. Response ids sit only in Technical details.
 */
import { formatDecisionRecordConsumerLine, type DecisionProofRecord } from "@/domain/decision-proof-view";
import { buyerSafeResaleJournalText } from "@/domain/resale-journal-copy";
import type { GoldenRun } from "./types";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderBuyerHtml(run: GoldenRun): string {
  const parts: string[] = ["<article class=\"golden-run\">"];
  if (run.buyer.headline) parts.push(`<h1>${esc(run.buyer.headline)}</h1>`);
  if (run.buyer.message) parts.push(`<p>${esc(run.buyer.message)}</p>`);
  if (run.buyer.nextStep) parts.push(`<p>${esc(run.buyer.nextStep)}</p>`);
  if (run.verdict) {
    const word = run.verdict.toLowerCase() === "needs_inspection" ? "Inspect first" : run.verdict;
    parts.push(`<p>Verdict: ${esc(word)}</p>`);
  }
  if (run.confidence) parts.push(`<p>Confidence: ${esc(run.confidence)}</p>`);

  const proofs = run.proofRecords.filter((row) => row.purpose && row.status) as DecisionProofRecord[];
  if (proofs.length) {
    parts.push("<ul>");
    for (const row of proofs) {
      parts.push(`<li>${esc(formatDecisionRecordConsumerLine(row))}</li>`);
    }
    parts.push("</ul>");
  }
  if (run.buyer.journal.length) {
    parts.push("<ol>");
    for (const line of run.buyer.journal) {
      parts.push(`<li>${esc(buyerSafeResaleJournalText(line))}</li>`);
    }
    parts.push("</ol>");
  }
  for (const car of run.listings) {
    const title = `${car.year} ${car.make} ${car.model}`;
    parts.push(`<section data-vin="${esc(car.vin)}">`);
    parts.push(`<h2>${esc(title)}</h2>`);
    if (car.dealer) parts.push(`<p>${esc(car.dealer)}</p>`);
    if (car.vdp) {
      const host = (() => {
        try {
          return new URL(car.vdp).hostname.replace(/^www\./, "");
        } catch {
          return "";
        }
      })();
      const label = host && car.vdp ? `Dealer listing (${host})` : "Dealer listing";
      parts.push(`<a href="${esc(car.vdp)}">${esc(label)}</a>`);
    }
    parts.push("</section>");
  }
  const ids = proofs
    .map((row) => row.servResponseId)
    .filter((id): id is string => Boolean(id));
  parts.push("<details class=\"technical-details\"><summary>Reference codes</summary>");
  for (const id of ids) parts.push(`<p class="response-id">${esc(id)}</p>`);
  parts.push("</details>");
  parts.push("</article>");
  return parts.join("");
}
