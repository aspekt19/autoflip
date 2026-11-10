import {
  formatDecisionRecordLine,
  type DecisionProofRecord,
} from "@/domain/decision-proof-view";

/** Shared lemonless.decision_proof.v1 journal — purpose, SERV id, what changed, raw response. */
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
          <p className="hint">
            <strong>{row.purpose}</strong>
            {" · "}
            {formatDecisionRecordLine(row)}
          </p>
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
