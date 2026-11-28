"use client";

import Link from "next/link";
import { useState } from "react";
import { ServChat, type ServChatDonePayload } from "@/components/ServChat";
import { ServDecisionJournal } from "@/components/ServDecisionJournal";
import type { AgentVerdict } from "@/domain/agent-verdict-schema";
import type { BestDealResult } from "@/domain/find-best-deal";
import { formatUsd } from "@/domain/format";
import { plainDecisionAction } from "@/domain/find-buyer-copy";
import { accidentHistoryBuyerLine } from "@/domain/accident-hard-constraint";
import { buyerDistanceText } from "@/domain/geo";
import { clipAtSentenceBoundary } from "@/domain/buyer-text";
import { formatShopperBriefCard, type ShopperBrief } from "@/domain/shopper-brief";
import { SourcesCheckedLine } from "@/components/SourcesCheckedLine";
import { PriceBadgeView } from "@/components/PriceBadge";
import { findCardPriceBadge } from "@/domain/find-card-price-badge";
import { findCardNote } from "@/domain/find-card-note";
import { buyerBodyLabel } from "@/domain/body-style";

/**
 * Find intake is one SERV chat window. Results reuse existing card/report shapes
 * from the chat API payload (bestDeal / pickAgentVerdict / confirmedBrief).
 */
export function FindChatFlow({ initialNote = null }: { initialNote?: string | null }) {
  const [done, setDone] = useState<ServChatDonePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!done) {
    return (
      <ServChat
        endpoint="/api/find/chat"
        initialMessage={initialNote}
        placeholder="Describe the car you need and your budget…"
        onDone={setDone}
        onError={setError}
      />
    );
  }

  const result = done.result;
  const bestDeal = (result.bestDeal ?? null) as BestDealResult | null;
  const verdict = (result.pickAgentVerdict ?? null) as AgentVerdict | null;
  const confirmedBrief = (result.confirmedBrief ?? null) as ShopperBrief | null;
  const creditNote = typeof result.creditNote === "string" ? result.creditNote : null;
  const honesty = typeof result.honesty === "string" ? result.honesty : null;
  const runId = typeof result.runId === "string" ? result.runId : null;
  const offerPool = (Array.isArray(result.offerPool) ? result.offerPool : []) as Array<{
    vin?: string | null;
    year: number;
    make: string;
    model: string;
    trim?: string | null;
    priceUsd?: number | null;
    miles?: number | null;
    bodyStyle?: string | null;
    style?: string | null;
    drivetrain?: string | null;
    distanceMiles?: number | null;
    radiusCheck?: "unverified" | "known" | null;
    accidentCount?: number | null;
    vdp?: string | null;
  }>;
  const ranked = bestDeal?.ranked ?? [];
  const whyByVin = new Map<string, string>();
  for (const reason of verdict?.reasons ?? []) {
    const id = reason.evidenceId?.replace(/^car:/i, "").toUpperCase() ?? "";
    if (id) whyByVin.set(id, reason.text);
  }
  const sourcesByVin = (result.sourcesCheckedByVin ?? {}) as Record<
    string,
    Array<{ source?: string; status?: string; label?: string }>
  >;
  const summaryWhy =
    bestDeal?.choice?.reasons?.[0]?.trim() ||
    verdict?.reasons?.[0]?.text?.trim() ||
    null;
  const poolByVin = new Map(
    offerPool
      .filter((row) => typeof row.vin === "string" && row.vin.trim())
      .map((row) => [String(row.vin).toUpperCase(), row] as const),
  );

  return (
    <div className="find-results" id="find-results">
      {honesty ? <p className="lead">{honesty}</p> : null}
      {creditNote ? <p className="hint">{creditNote}</p> : null}
      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}

      {confirmedBrief ? (
        <section className="onboarding-note" aria-label="Confirmed search brief">
          <h2>Confirmed brief</h2>
          <pre className="hint" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
            {formatShopperBriefCard(confirmedBrief)}
          </pre>
        </section>
      ) : null}

      {runId && ranked.length > 0 ? (
        <p className="btn-row">
          <Link className="quiet" href={`/run/${runId}`}>
            Open match report
          </Link>
        </p>
      ) : null}

      {ranked.length === 0 ? (
        <p className="lead">SERV did not choose a car from live inventory for this chat.</p>
      ) : (
        <div className="find-results-grid listing-grid">
          {ranked.slice(0, 8).map((car) => {
            const vin = car.vin?.toUpperCase() ?? "";
            // Only the winning card carries the decision; every other card gets its own note.
            const { note: whyRaw, isWinner } = findCardNote({
              car,
              pick: bestDeal?.pick ?? ranked[0] ?? null,
              decisionText: summaryWhy,
              carReason: (vin && whyByVin.get(vin)) || null,
            });
            const pool = vin ? poolByVin.get(vin) : null;
            const poolKnown =
              pool?.radiusCheck === "known" &&
              typeof pool.distanceMiles === "number" &&
              Number.isFinite(pool.distanceMiles);
            const carKnown =
              car.radiusCheck === "known" &&
              typeof car.distanceMiles === "number" &&
              Number.isFinite(car.distanceMiles);
            const distance = carKnown
              ? car.distanceMiles
              : poolKnown
                ? pool!.distanceMiles
                : (car.distanceMiles ?? pool?.distanceMiles ?? null);
            const radiusCheck = carKnown || poolKnown ? "known" as const : (car.radiusCheck ?? pool?.radiusCheck);
            const historyLine = accidentHistoryBuyerLine(car.accidentCount ?? pool?.accidentCount);
            const body = buyerBodyLabel(car.bodyStyle ?? pool?.bodyStyle ?? null, car.style ?? pool?.style ?? null);
            const drivetrain = car.drivetrain ?? pool?.drivetrain ?? null;
            const vdp =
              (typeof car.vdp === "string" && car.vdp.trim() ? car.vdp.trim() : null) ||
              (typeof pool?.vdp === "string" && pool.vdp.trim() ? pool.vdp.trim() : null);
            const badge = findCardPriceBadge(car, offerPool.length > 0 ? offerPool : ranked);
            return (
              <article key={car.key} className="listing-card">
                <div className="listing-body">
                  <h3>
                    {car.year} {car.make} {car.model}
                  </h3>
                  <p>
                    {car.priceUsd != null ? formatUsd(car.priceUsd) : "Price unknown"}
                    {car.miles != null ? ` · ${car.miles.toLocaleString("en-US")} mi` : ""}
                    {` · ${buyerDistanceText({
                      distanceMiles: distance,
                      radiusCheck,
                    })}`}
                    {historyLine ? ` · ${historyLine}` : ""}
                  </p>
                  <p className="hint">
                    {[body, drivetrain].filter(Boolean).join(" · ") || "Body/drivetrain not listed"}
                  </p>
                  {car.vin ? <p className="hint">VIN {car.vin}</p> : null}
                  {car.city || car.state ? (
                    <p className="hint">
                      {[car.city, car.state].filter(Boolean).join(", ")}
                    </p>
                  ) : null}
                  {whyRaw ? <ExpandableReason text={whyRaw} /> : null}
                  {isWinner && verdict?.verdict ? (
                    <p>
                      <strong>{plainDecisionAction(verdict.verdict)}</strong>
                      {verdict.confidence ? ` · ${verdict.confidence} confidence` : ""}
                    </p>
                  ) : null}
                  <PriceBadgeView badge={badge} />
                  <SourcesCheckedLine items={vin ? sourcesByVin[vin] : null} />
                  {vdp && /^https?:\/\//i.test(vdp) ? (
                    <p>
                      <a href={vdp} target="_blank" rel="noreferrer">
                        Listing
                      </a>
                    </p>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <ServDecisionJournal agentVerdict={verdict} defaultOpen verifyId={runId} />
    </div>
  );
}

/** Show the full reason when it fits; otherwise clip at a sentence and let the buyer expand it. */
function ExpandableReason({ text }: { text: string }) {
  const { text: preview, clipped } = clipAtSentenceBoundary(text, 1200);
  if (!clipped) return <p>{text}</p>;
  return (
    <details>
      <summary>{preview}</summary>
      <p>{text}</p>
    </details>
  );
}
