import type { Metadata } from "next";
import { ScoutPanel } from "@/components/ScoutPanel";
import { isScoutUiEnabled } from "@/server/scout/config";

export const metadata: Metadata = { title: "Scout" };

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
              <strong>Offline / replay by default</strong>
              <p>
                Runs use the checked-in Auto.dev Camry snapshot unless live execution is explicitly
                server-authorized. Fixture rows are never presented as a live market pull.
              </p>
            </div>
            <ScoutPanel />
          </>
        )}
      </div>
    </div>
  );
}
