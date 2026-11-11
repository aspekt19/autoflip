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
      <div className="flow-page site-frame">
        <p className="kicker">Scout</p>
        <h1>Investigation shortlist</h1>
        <p className="lead">
          Scout looks for up to five cars worth a closer look, or it says it cannot. Asking prices are what sellers
          claim. Missing history is not a safe buy or a profit.
        </p>

        {!enabled ? (
          <div className="onboarding-note">
            <strong>Scout is not available right now</strong>
            <p>There is no investigation list to show. Nothing is filled in to look finished.</p>
            <details>
              <summary>Technical details</summary>
              <p>
                The screen stays off until <code>SCOUT_UI_ENABLED</code> is turned on. The API stays separately gated by{" "}
                <code>SCOUT_ENABLED</code>. Live listing search needs <code>SCOUT_PAID_EXECUTION</code> on the server,
                plus a key and a hard ceiling. A browser cannot grant that by itself.
              </p>
            </details>
          </div>
        ) : (
          <>
            <div className="onboarding-note">
              <strong>Your search</strong>
              <p>
                Open a Scout session, then enter makes, a ZIP code, distance, and a budget. Live listings need an
                explicit grant. A signed-out browser cannot inherit that grant, and sample rows are never shown as live
                cars.
              </p>
            </div>
            <ScoutPanel />
          </>
        )}
      </div>
    </div>
  );
}
