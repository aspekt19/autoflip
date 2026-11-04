import Link from "next/link";
import { ReportView } from "@/components/ReportView";
import { buildSampleReport } from "@/server/sample-report";

export default function SampleReportPage() {
  const report = buildSampleReport("personal");
  return (
    <div className="sub">
      <div className="sheet-page">
        <p>
          <Link href="/">Back to the start</Link>
        </p>
        <ReportView report={report} />
      </div>
    </div>
  );
}
