import type { Metadata } from "next";
import Link from "next/link";
import { listUserReports } from "@/io/persist-report";
import { ReportHistoryList } from "@/components/ReportHistoryList";
import { getKv } from "@/io/kv";
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
          <ReportHistoryList reports={reports} />
        )}
        <p className="hint">Reports generated before report history was added may not be listed here. Their original report links still work while the saved report remains available.</p>
      </div>
    </div>
  );
}
