import { NextResponse } from "next/server";
import { verifyDecisionAuditTrail, type DecisionAuditTrail } from "@/domain/decision-audit-chain";
import { loadDecisionAuditTrail } from "@/io/decision-audit-store";
import { readPersistedReport } from "@/io/persist-report";
import { hashReport } from "@/domain/decision-audit-chain";

export const dynamic = "force-dynamic";

/**
 * Public verify endpoint — no auth.
 * GET ?id=<reportOrRunId> → load sealed trail + recompute.
 * POST { trail } → verify a submitted trail body.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id")?.trim();
  if (!id) {
    return NextResponse.json(
      {
        ok: false,
        error: "missing_id",
        message: "Enter a report id.",
      },
      { status: 400 },
    );
  }

  const trail = await loadDecisionAuditTrail(id);
  if (!trail) {
    return NextResponse.json(
      {
        ok: false,
        error: "not_found",
        message: "No saved decision is stored for that report id.",
        reportId: id,
      },
      { status: 404 },
    );
  }

  const verified = verifyDecisionAuditTrail(trail);
  let reportHashMatch: boolean | null = null;
  const report = await readPersistedReport(id);
  if (report) {
    reportHashMatch = hashReport(report) === trail.reportHash;
    if (!reportHashMatch) {
      verified.ok = false;
      verified.issues = [...verified.issues, "The saved report no longer matches the sealed copy."];
    }
  }

  return NextResponse.json({
    ok: verified.ok,
    reportId: verified.reportId,
    reportHash: verified.reportHash,
    tipHash: verified.tipHash,
    linkCount: verified.linkCount,
    issues: verified.issues,
    reportHashMatch,
    sealedAt: trail.sealedAt,
    steps: trail.links.map((link) => ({
      index: link.index,
      hash: link.hash,
      prevHash: link.prevHash,
      step: link.step.step,
      by: link.step.by,
      status: link.step.status,
      runId: link.step.runId,
      modelId: link.step.modelId,
    })),
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json", issues: ["Body must be JSON"] }, { status: 400 });
  }
  const trail = (body as { trail?: DecisionAuditTrail }).trail ?? (body as DecisionAuditTrail);
  if (!trail || typeof trail !== "object" || !("links" in trail)) {
    return NextResponse.json(
      { ok: false, error: "missing_trail", issues: ["POST a { trail } object or a bare DecisionAuditTrail"] },
      { status: 400 },
    );
  }
  const verified = verifyDecisionAuditTrail(trail as DecisionAuditTrail);
  return NextResponse.json(verified, { status: verified.ok ? 200 : 400 });
}
