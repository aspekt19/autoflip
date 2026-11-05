import type { Metadata } from "next";
import Link from "next/link";
import { getKv } from "@/io/kv";
import { listFavoriteReports } from "@/io/persist-report";
import { existingUserId, isDemoUser } from "@/server/session";
import { formatNumber, formatUsd, verdictLabel } from "@/domain/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Saved cars" };

export default async function FavoritesPage() {
  const id = await existingUserId();
  const demo = id ? isDemoUser(id) : false;
  const favorites = id ? await listFavoriteReports(getKv(), id) : [];

  return (
    <div className="sub">
      <div className="sheet-page">
        <p className="kicker">{demo ? "Shared demo" : "This browser"}</p>
        <h1>Saved cars</h1>
        <p className="lead">Cars you marked as favorites from a full report. Save a car to return to its report without running it again.</p>
        {demo ? <p className="warn-box">Shared demo: saved cars may be visible to other demo visitors.</p> : <p className="hint">Saved cars are linked to this browser session.</p>}
        {favorites.length === 0 ? (
          <article className="warn-box">
            <h2>No saved cars yet</h2>
            <p>Open a full vehicle report and choose “Save car”. The free quick price check cannot be saved here.</p>
            <p><Link className="action" href="/reports">Open report history</Link> <Link className="quiet" href="/check">Check a car</Link></p>
          </article>
        ) : (
          <div className="report-history-list">
            {favorites.map((report) => (
              <article className="report-history-card" key={report.id}>
                <div className="report-history-copy">
                  <p className="sheet-label">{report.mode === "flip" ? "For resale" : "For me"}</p>
                  <h2>{report.title}</h2>
                  <p className="hint">{new Date(report.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · VIN {report.vin}</p>
                  <p className="support">{report.priceUsd === null ? "Price not listed" : formatUsd(report.priceUsd)} · {report.miles === null ? "Mileage not listed" : `${formatNumber(report.miles)} miles`}</p>
                </div>
                <div className="report-history-action">
                  <span className={`verdict-level badge ${report.verdict}`}>{verdictLabel(report.verdict)}</span>
                  <Link className="quiet" href={`/report/${report.id}`}>Open report</Link>
                </div>
              </article>
            ))}
          </div>
        )}
        <p><Link href="/reports">Back to my reports</Link></p>
      </div>
    </div>
  );
}
