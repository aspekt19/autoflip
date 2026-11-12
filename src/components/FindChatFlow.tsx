"use client";

import { useState } from "react";
import { ServChat, type ServChatDonePayload } from "@/components/ServChat";
import { ServDecisionJournal } from "@/components/ServDecisionJournal";
import type { AgentVerdict } from "@/domain/agent-verdict-schema";
import type { BestDealResult } from "@/domain/find-best-deal";
import { formatUsd } from "@/domain/format";

/**
 * Find intake is one SERV chat window. Results reuse existing card/report shapes
 * from the chat API payload (bestDeal / pickAgentVerdict).
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
  const creditNote = typeof result.creditNote === "string" ? result.creditNote : null;
  const honesty = typeof result.honesty === "string" ? result.honesty : null;
  const ranked = bestDeal?.ranked ?? [];

  return (
    <div className="find-results" id="find-results">
      {honesty ? <p className="lead">{honesty}</p> : null}
      {creditNote ? <p className="hint">{creditNote}</p> : null}
      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}

      {ranked.length === 0 ? (
        <p className="lead">SERV did not choose a car from live inventory for this chat.</p>
      ) : (
        <div className="find-results-grid listing-grid">
          {ranked.slice(0, 8).map((car) => (
            <article key={car.key} className="listing-card">
              <div className="listing-body">
                <h3>
                  {car.year} {car.make} {car.model}
                </h3>
                <p>
                  {car.priceUsd != null ? formatUsd(car.priceUsd) : "Price unknown"}
                  {car.miles != null ? ` · ${car.miles.toLocaleString("en-US")} mi` : ""}
                </p>
                {car.vin ? <p className="hint">VIN {car.vin}</p> : null}
                {car.city || car.state ? (
                  <p className="hint">
                    {[car.city, car.state].filter(Boolean).join(", ")}
                  </p>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}

      <ServDecisionJournal agentVerdict={verdict} defaultOpen />
    </div>
  );
}
