import { NextResponse } from "next/server";
import { emptyServRunAggregateStats } from "@/domain/decision-audit-chain";
import { loadServRunAggregateStats } from "@/io/decision-audit-store";

export const dynamic = "force-dynamic";

/** Public aggregate stats from sealed decision trails only — never invented. */
export async function GET() {
  try {
    const stats = await loadServRunAggregateStats();
    return NextResponse.json({
      ...stats,
      empty: stats.trailCount === 0,
    });
  } catch {
    const empty = emptyServRunAggregateStats();
    return NextResponse.json({ ...empty, empty: true });
  }
}
