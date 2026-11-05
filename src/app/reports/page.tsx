import type { Metadata } from "next";
import Link from "next/link";
import { listUserReports } from "@/io/persist-report";
import { getKv } from "@/io/kv";
import { formatNumber, formatUsd, verdictLabel } from "@/domain/format";
import { existingUserId, isDemoUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "My reports" };

export default async function ReportsPage() {
  // Read the existing cookie without creating one: Server Components cannot set cookies.
  const id = await existingUserId();
  const demo = id ? isDemoUser(id) : false;
  const reports = id ? await listUserReports(getKv(), id) : [];

  return (
    <div className="sub">
      <div className="sheet-page">
        <p className="kicker">{demo ? "Shared demo" : "This browser"}</p>
        <h1>My reports</h1>
        <p className="lead">Reports you generated are collected here so you can reopen them without searching for the original link.</p>
        {demo ? (
          <p className="warn-box">You are using the shared demo account. Reports created by other demo visitors may also appear here.</p>
        ) : (
          <p className="hint">Preview reports are linked to this browser session. Keep using the same browser to retain access.</p>
        )}
        {reports.length === 0 ? (
          <article className="warn-box">
            <h2>No saved reports yet</h2>
            <p>Run a full vehicle report and it will appear here. The free quick price check is not saved as a full report.</p>
            <p><Link className="action" href="/check">Check a car</Link> <Link className="quiet" href="/find">Find a car</Link></p>
          </article>
        ) : (
          <div className="report-history-list">
            {reports.map((report) => (
              <article className="report-history-card" key={report.id}>
                <div className="report-history-copy">
                  <p className="sheet-label">{report.mode === "flip" ? "For resale" : "For me"}{report.sample ? " · Sample" : ""}</p>
                  <h2>{report.title}</h2>
                  <p className="hint">
                    {new Date(report.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
                    {" · VIN "}{report.vin}
                  </p>
                  <p className="support">
                    {report.priceUsd === null ? "Price not listed" : formatUsd(report.priceUsd)}
                    {" · "}
                    {report.miles === null ? "Mileage not listed" : `${formatNumber(report.miles)} miles`}
                    {report.city ? ` · ${report.city}, ${report.state ?? ""}` : ""}
                  </p>
                </div>
                <div className="report-history-action">
                  <span className={`verdict-level badge ${report.verdict}`}>{verdictLabel(report.verdict)}</span>
                  <Link className="quiet" href={`/report/${report.id}`}>Open report</Link>
                </div>
              </article>
            ))}
          </div>
        )}
        <p className="hint">Reports generated before report history was added may not be listed here. Their original report links still work while the saved report remains available.</p>
      </div>
    </div>
  );
}
