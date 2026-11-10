import type { Metadata } from "next";
import Link from "next/link";
import { ReportView } from "@/components/ReportView";
import { buildSampleReport } from "@/server/sample-report";

export const metadata: Metadata = { title: "Sample" };

export default function SampleReportPage() {
  const report = buildSampleReport("personal");
  return (
    <div className="sub">
      <div className="sheet-page site-frame">
        <p>
          <Link href="/">Back to the start</Link>
        </p>
        <ReportView report={report} />
      </div>
    </div>
  );
}
