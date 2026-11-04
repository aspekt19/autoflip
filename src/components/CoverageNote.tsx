import { coverageConfidence, coverageSentence, type CoverageConfidence, type CoverageInput } from "@/domain/coverage";

const LABEL: Record<CoverageConfidence, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export function CoverageNote({ input }: { input: CoverageInput }) {
  const confidence = coverageConfidence(input);
  return (
    <p className="coverage">
      <span className={`coverage-badge ${confidence}`}>Confidence {LABEL[confidence]}</span>
      <span className="coverage-line">{coverageSentence(input)}</span>
    </p>
  );
}

export function CoverageLine({ confidence, sentence }: { confidence: CoverageConfidence; sentence: string }) {
  return (
    <p className="coverage">
      <span className={`coverage-badge ${confidence}`}>Confidence {LABEL[confidence]}</span>
      <span className="coverage-line">{sentence}</span>
    </p>
  );
}
