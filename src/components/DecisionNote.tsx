import { whyWeDecided, type DecisionProof, type DecisionScene } from "@/domain/decision-note";

export function DecisionNote({ scene, proofs }: { scene: DecisionScene; proofs: DecisionProof[] }) {
  const paragraphs = whyWeDecided(scene, proofs);
  return (
    <details className="decision">
      <summary>Why we decided this</summary>
      {paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </details>
  );
}
