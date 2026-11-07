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
              <strong>Your mandate · offline by default</strong>
              <p>
                Enter your own makes, ZIP, distance, and budget. Replay uses a checked-in Auto.dev
                snapshot unless the server authorizes live for an allowlisted owner. Prefer-live never
                substitutes fixture rows as a live market pull — it fails closed when blocked.
              </p>
            </div>
            <ScoutPanel />
          </>
        )}
      </div>
    </div>
  );
}
