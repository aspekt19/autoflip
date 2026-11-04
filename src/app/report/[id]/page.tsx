import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReportView } from "@/components/ReportView";
import { readPersistedReport } from "@/io/persist-report";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Report" };

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = await readPersistedReport(id);
  if (!report) notFound();
  return (
    <div className="sub">
      <div className="sheet-page">
        <ReportView report={report} />
      </div>
    </div>
  );
}
