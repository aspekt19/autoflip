import {
  formatDecisionRecordLine,
  type DecisionProofRecord,
} from "@/domain/decision-proof-view";

/** Compact one-line proof for Find / Radar — SERV id or the real failure reason. */
export function DecisionRecordList({
  records,
  emptyHint,
}: {
  records: readonly DecisionProofRecord[] | null | undefined;
  emptyHint?: string | null;
}) {
  const rows = Array.isArray(records) ? records.filter(Boolean) : [];
  if (rows.length === 0) {
    return emptyHint ? <p className="hint">{emptyHint}</p> : null;
  }
  return (
    <ul className="decision-record-list">
      {rows.map((row) => (
        <li key={`${row.purpose}-${row.timestamp}-${row.servResponseId ?? row.reason ?? "x"}`}>
          <p className="hint">{formatDecisionRecordLine(row)}</p>
          {row.rawResponse ? (
            <details className="onboarding-note">
              <summary>Open agent response</summary>
              <p className="hint" style={{ whiteSpace: "pre-wrap" }}>
                {row.rawResponse}
              </p>
            </details>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
