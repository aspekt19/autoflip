"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatNumber, formatUsd, verdictLabel } from "@/domain/format";
import type { UserReportSummary } from "@/io/persist-report";

export function ReportHistoryList({ reports }: { reports: UserReportSummary[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);

  function toggle(id: string, checked: boolean) {
    setSelected((current) => {
      if (checked) return current.length >= 3 ? current : [...current, id];
      return current.filter((item) => item !== id);
    });
  }

  function compare() {
    if (selected.length < 2) return;
    const query = new URLSearchParams();
    selected.forEach((id) => query.append("id", id));
    router.push(`/compare-cars?${query.toString()}`);
  }

  return (
    <>
      <div className="compare-picker">
        <div>
          <strong>Compare reports side by side</strong>
          <p className="hint">Select 2 or 3 cars. Lemonless compares the saved report snapshots without spending another credit.</p>
        </div>
        <button className="action" type="button" onClick={compare} disabled={selected.length < 2}>
          Compare selected ({selected.length}/3)
        </button>
      </div>
      <div className="report-history-list">
        {reports.map((report) => (
          <article className="report-history-card" key={report.id}>
            <div className="report-history-copy">
              <label className="compare-select">
                <input
                  type="checkbox"
                  checked={selected.includes(report.id)}
                  disabled={!selected.includes(report.id) && selected.length >= 3}
                  onChange={(event) => toggle(report.id, event.target.checked)}
                />
                <span>Compare</span>
              </label>
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
    </>
  );
}
