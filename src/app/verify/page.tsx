import type { Metadata } from "next";
import Link from "next/link";
import { VerifyForm } from "./VerifyForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Check a saved decision" };

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const params = await searchParams;
  const initialId = typeof params.id === "string" ? params.id.trim() : "";

  return (
    <div className="sub">
      <div className="sheet-page site-frame prose">
        <p className="kicker">Audit</p>
        <h1>Check a saved decision</h1>
        <p className="lead">
          When Lemonless seals a report, it stores a fingerprint of that report and a chain of the steps that led to the
          decision. This page recomputes those fingerprints. It does not take a payment, and it does not publish the
          report anywhere else.
        </p>
        <VerifyForm initialId={initialId} />
        <p className="hint">
          <Link href="/where-serv-runs">Where SERV runs</Link>
        </p>
        <details className="onboarding-note">
          <summary>Technical details</summary>
          <p className="hint">
            GET /api/verify?id=… or POST /api/verify with a sealed trail. Fingerprints are sha256. There is no outside
            ledger.
          </p>
        </details>
      </div>
    </div>
  );
}
