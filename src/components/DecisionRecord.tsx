import {
  formatDecisionRecordLine,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";

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
        </li>
      ))}
    </ul>
  );
}
