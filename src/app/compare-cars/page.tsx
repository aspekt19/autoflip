import type { Metadata } from "next";
import Link from "next/link";
import { formatNumber, formatPct, formatUsd, verdictLabel } from "@/domain/format";
import { getKv } from "@/io/kv";
import { listUserReports, readPersistedReport } from "@/io/persist-report";
import { existingUserId } from "@/server/session";
import type { FullReport } from "@/domain/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Compare cars" };

type Row = { label: string; value: (report: FullReport) => string };

const ROWS: Row[] = [
  { label: "Purpose", value: (r) => r.computed.mode === "flip" ? "For resale" : "For me" },
  { label: "Verdict", value: (r) => verdictLabel(r.computed.verdict) },
  { label: "Asking price", value: (r) => r.computed.subject.priceUsd === null ? "Not available" : formatUsd(r.computed.subject.priceUsd) },
  { label: "Estimated fair value", value: (r) => r.computed.fairValueUsd === null ? "Not enough comparable data" : formatUsd(r.computed.fairValueUsd) },
  { label: "Asking vs fair value", value: (r) => r.computed.priceGap === null ? "Not enough comparable data" : `${formatPct(Math.abs(r.computed.priceGap))} ${r.computed.priceGap >= 0 ? "above" : "below"} fair value` },
  { label: "Mileage", value: (r) => r.computed.subject.miles === null ? "Not available" : `${formatNumber(r.computed.subject.miles)} miles` },
  { label: "Accidents reported", value: (r) => r.computed.subject.accidentCount === null ? "Not disclosed in data" : String(r.computed.subject.accidentCount) },
  { label: "NHTSA recall campaigns", value: (r) => r.computed.recallsAvailable ? String(r.computed.recalls.length) : "Unavailable — check by VIN" },
  { label: "parkIt (do-not-drive until VIN verified)", value: (r) => !r.computed.recallsAvailable ? "Could not check — unknown, not cleared" : r.computed.openParkIt ? "Yes — model-year parkIt; verify VIN applicability and repair" : "No parkIt flag in returned campaigns (not VIN-cleared)" },
  { label: "parkOutside (not do-not-drive alone)", value: (r) => !r.computed.recallsAvailable ? "Could not check — unknown, not cleared" : r.computed.openParkOutside ? "Yes — outdoor parking guidance; not parkIt by itself" : "No parkOutside flag in returned campaigns (not VIN-cleared)" },
  { label: "NHTSA model-year complaints", value: (r) => r.computed.complaintCount === null ? "Unavailable" : `${r.computed.complaintCount} (allegations, not defect proof)` },
  { label: "Comparable listings used", value: (r) => String(r.computed.comps.length) },
  { label: "Risk flags", value: (r) => `${r.computed.flags.filter((f) => f.level === "stop").length} stop · ${r.computed.flags.filter((f) => f.level === "caution").length} caution · ${r.computed.flags.filter((f) => f.level === "note").length} notes` },
  { label: "Data gaps", value: (r) => r.computed.dataNotes.length ? r.computed.dataNotes.slice(0, 2).join(" ") : "No additional gaps flagged" },
];

export default async function CompareCarsPage({ searchParams }: { searchParams: Promise<{ id?: string | string[] }> }) {
  const params = await searchParams;
  const requested = Array.isArray(params.id) ? params.id : params.id ? [params.id] : [];
  const ids = [...new Set(requested)].slice(0, 3);
  const user = await existingUserId();
  const summaries = user ? await listUserReports(getKv(), user) : [];
  const owned = new Set(summaries.map((item) => item.id));
  const allowedIds = ids.filter((id) => owned.has(id));
  const reports = (await Promise.all(allowedIds.map((id) => readPersistedReport(id)))).filter((r): r is FullReport => Boolean(r));

  return (
    <div className="sub">
      <div className="sheet-page">
        <p className="kicker">Side-by-side report comparison</p>
        <h1>Compare cars</h1>
        <p className="lead">Compare the saved report snapshots for 2 or 3 vehicles. This uses existing reports and does not spend another credit.</p>
        {requested.length > 3 ? <p className="warn-box">Only the first three selected reports are compared.</p> : null}
        {reports.length < 2 ? (
          <article className="warn-box">
            <h2>Select at least two saved reports</h2>
            <p>Only reports saved in this browser session can be compared. Generate a full report for each car first.</p>
            <p><Link className="action" href="/reports">Choose reports</Link> <Link className="quiet" href="/check">Check a car</Link></p>
          </article>
        ) : (
          <>
            <div className="vehicle-compare-head">
              {reports.map((report) => (
                <article key={report.id}>
                  <p className="sheet-label">{report.computed.mode === "flip" ? "For resale" : "For me"}</p>
                  <h2>{report.computed.subject.year} {report.computed.subject.make} {report.computed.subject.model}</h2>
                  <p className="support">{report.computed.subject.vin}</p>
                  <p><span className={`verdict-level badge ${report.computed.verdict}`}>{verdictLabel(report.computed.verdict)}</span></p>
                  <Link className="quiet" href={`/report/${report.id}`}>Open report</Link>
                </article>
              ))}
            </div>
            <div className="table-scroll vehicle-compare-table">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Check</th>
                    {reports.map((report) => <th scope="col" key={report.id}>{report.computed.subject.year} {report.computed.subject.make} {report.computed.subject.model}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map((row) => (
                    <tr key={row.label}>
                      <th scope="row">{row.label}</th>
                      {reports.map((report) => <td key={report.id}>{row.value(report)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">These are saved report snapshots created at different times and potentially from different ZIP codes or listing prices. Recall and complaint counts are model-year data, not a complete vehicle history or a substitute for an inspection.</p>
          </>
        )}
      </div>
    </div>
  );
}
