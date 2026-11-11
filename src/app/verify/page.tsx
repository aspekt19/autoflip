import type { Metadata } from "next";
import Link from "next/link";
import { VerifyForm } from "./VerifyForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Verify decision trail" };

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
        <h1>Verify a decision trail</h1>
        <p className="lead">
          Each sealed report stores a sha256 of the report payload and a hash-linked chain of decision steps. This page
          recomputes those hashes. There is no external ledger anchoring and no payment step.
        </p>
        <VerifyForm initialId={initialId} />
        <p className="hint">
          API: <code>GET /api/verify?id=…</code> · <code>POST /api/verify</code> with a trail body.{" "}
          <Link href="/where-serv-runs">Where SERV runs</Link>.
        </p>
      </div>
    </div>
  );
}
