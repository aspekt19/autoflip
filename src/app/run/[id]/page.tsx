import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RunReport } from "@/components/RunReport";
import { toRunView } from "@/domain/run";
import { readRun } from "@/io/run-store";
import { getKv } from "@/io/kv";
import { authenticatedAccountId } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Search" };

/** Public permalink. Signed-out visitors see the report. Owner-only actions stay hidden. */
export default async function RunPermalinkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await readRun(getKv(), id);
  if (!run) notFound();
  const viewerId = await authenticatedAccountId();
  return (
    <div className="sub">
      <div className="sheet-page site-frame">
        <RunReport run={toRunView(run, viewerId)} />
      </div>
    </div>
  );
}
