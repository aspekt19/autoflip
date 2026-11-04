import Link from "next/link";
import { ReportView } from "@/components/ReportView";
import { loadReport } from "@/io/store";

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = loadReport(id);
  if (!report) {
    return (
      <div className="sub">
        <div className="sheet-page">
        <h1>Report unavailable</h1>
        <p className="lead">
          This server does not have that report. Stored reports sit on local disk and can disappear when the host restarts.
        </p>
        <p>
          <Link href="/">Start another search</Link>
        </p>
        </div>
      </div>
    );
  }
  return (
    <div className="sub">
      <div className="sheet-page">
        <ReportView report={report} />
      </div>
    </div>
  );
}
