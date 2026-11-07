import type { Metadata } from "next";
import { ScoutPanel } from "@/components/ScoutPanel";
import { isScoutUiEnabled } from "@/server/scout/config";

export const metadata: Metadata = { title: "Scout" };

/** Runtime flag — must not bake SCOUT_UI_ENABLED at build time. */
export const dynamic = "force-dynamic";

export default function ScoutPage() {
  const enabled = isScoutUiEnabled();

  return (
    <div className="sub">
      <div className="flow-page">
        <p className="kicker">Scout</p>
        <h1>Investigation shortlist</h1>
        <p className="lead">
          Bounded loop that returns ≤5 evidence-backed investigation candidates — or an honest abstain.
          Asking prices are seller claims. Unknown history does not become a verified safe buy or profit.
        </p>

        {!enabled ? (
          <div className="onboarding-note">
            <strong>Scout UI is off</strong>
            <p>
              Set <code>SCOUT_UI_ENABLED=true</code> to show the runner. The API remains separately gated by{" "}
              <code>SCOUT_ENABLED</code>. Live Auto.dev requires server{" "}
              <code>SCOUT_PAID_EXECUTION</code> plus key and hard ceiling — never client balance attestation.
            </p>
          </div>
        ) : (
          <>
            <div className="onboarding-note">
              <strong>Signed session · your mandate</strong>
              <p>
                Open a Scout session with a grant-bound API key (once). Enter your own makes, ZIP,
                distance, and budget. Live Autodev requires an explicit owner grant — prefer-live
                fails closed and never substitutes fixture rows as live. Unsigned browser cookies
                cannot inherit owner privileges.
              </p>
            </div>
            <ScoutPanel />
          </>
        )}
      </div>
    </div>
  );
}
