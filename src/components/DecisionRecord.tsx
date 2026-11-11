import {
  formatDecisionRecordConsumerLine,
  formatDecisionRecordLine,
  type DecisionProofRecord,
} from "@/domain/decision-proof-view";

/** Shared lemonless.decision_proof.v1 journal — purpose, SERV id, what changed, raw response. */
export function DecisionRecordList({
  records,
  emptyHint,
  mode = "consumer",
}: {
  records: readonly DecisionProofRecord[] | null | undefined;
  emptyHint?: string | null;
  /**
   * consumer = plain English only (no ids/models/timestamps/raw).
   * proof = full technical line + raw response (for the single Show proof expander).
   */
  mode?: "consumer" | "proof";
}) {
  const rows = Array.isArray(records) ? records.filter(Boolean) : [];
  if (rows.length === 0) {
    return emptyHint ? <p className="hint">{emptyHint}</p> : null;
  }
  if (mode === "consumer") {
    return (
      <ul className="decision-record-list">
        {rows.map((row) => (
          <li key={`${row.purpose}-${row.timestamp}-${row.servResponseId ?? row.reason ?? "x"}`}>
            <p className="hint">{formatDecisionRecordConsumerLine(row)}</p>
          </li>
        ))}
      </ul>
    );
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
            <p className="hint" style={{ whiteSpace: "pre-wrap" }}>
              {row.rawResponse}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
