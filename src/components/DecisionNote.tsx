import { whyWeDecided, type DecisionProof, type DecisionScene } from "@/domain/decision-note";
import { plainDecisionEngineText } from "@/domain/find-buyer-copy";

export function DecisionNote({ scene, proofs }: { scene: DecisionScene; proofs: DecisionProof[] }) {
  const paragraphs = whyWeDecided(scene, proofs);
  return (
    <details className="decision">
      <summary className="type-brand">Why we decided this</summary>
      {paragraphs.map((paragraph) => (
        <p key={paragraph}>{plainDecisionEngineText(paragraph)}</p>
      ))}
    </details>
  );
}
