"use client";

import Link from "next/link";
import { useState } from "react";
import { ServChat, type ServChatDonePayload } from "@/components/ServChat";
import { ServDecisionJournal } from "@/components/ServDecisionJournal";
import type { AgentVerdict } from "@/domain/agent-verdict-schema";
import type { BestDealResult } from "@/domain/find-best-deal";
import { formatUsd } from "@/domain/format";
import { formatShopperBriefCard, type ShopperBrief } from "@/domain/shopper-brief";

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
    bodyStyle?: string | null;
    drivetrain?: string | null;
    distanceMiles?: number | null;
    vdp?: string | null;
  }>;
  const ranked = bestDeal?.ranked ?? [];
  const whyByVin = new Map<string, string>();
  for (const reason of verdict?.reasons ?? []) {
    const id = reason.evidenceId?.replace(/^car:/i, "").toUpperCase() ?? "";
    if (id) whyByVin.set(id, reason.text);
  }
  const summaryWhy = bestDeal?.why?.trim() || verdict?.reasons?.[0]?.text || null;
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

      {runId ? (
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
            const why = (vin && whyByVin.get(vin)) || summaryWhy;
            const pool = vin ? poolByVin.get(vin) : null;
            const distance = car.distanceMiles ?? pool?.distanceMiles ?? null;
            const body = pool?.bodyStyle ?? null;
            const drivetrain = car.drivetrain ?? pool?.drivetrain ?? null;
            const vdp =
              (typeof car.vdp === "string" && car.vdp.trim() ? car.vdp.trim() : null) ||
              (typeof pool?.vdp === "string" && pool.vdp.trim() ? pool.vdp.trim() : null);
            return (
              <article key={car.key} className="listing-card">
                <div className="listing-body">
                  <h3>
                    {car.year} {car.make} {car.model}
                  </h3>
                  <p>
                    {car.priceUsd != null ? formatUsd(car.priceUsd) : "Price unknown"}
                    {car.miles != null ? ` · ${car.miles.toLocaleString("en-US")} mi` : ""}
                    {distance != null ? ` · ${Math.round(distance)} mi away` : ""}
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
                  {why ? <p>{why}</p> : null}
                  {vdp ? (
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
