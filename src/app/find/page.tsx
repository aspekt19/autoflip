import type { Metadata } from "next";
import { FindFlow } from "@/components/AssistantFlow";
import { SignInGate } from "@/components/SignInGate";
import { FIND_PAGE_BILLING_STEP } from "@/domain/find-buyer-copy";
import { parseFindEntryParams } from "@/domain/need";
import { resolveProductFlags } from "@/domain/product-flags";

export const metadata: Metadata = { title: "Find a car" };

export default async function FindPage({
  searchParams,
}: {
  searchParams: Promise<{ note?: string; mode?: string; zip?: string; distanceMiles?: string }>;
}) {
  const params = await searchParams;
  const entry = parseFindEntryParams(params);

  return (
    <div className="sub">
      <div className="flow-page site-frame">
        <p className="kicker">Help me choose</p>
        <h1>What kind of car do you need?</h1>
        <div className="onboarding-note">
          <strong>How this works</strong>
          <ol>
            <li>Describe the car and your budget.</li>
            <li>Add a U.S. ZIP and seller-distance radius when you want nearby listings — or choose Nationwide.</li>
            <li>Review matching dealer listings. {FIND_PAGE_BILLING_STEP}</li>
          </ol>
          {resolveProductFlags().dealRadar ? <p>Deal Radar is a separate optional monthly plan.</p> : null}
        </div>
        <SignInGate callbackPath="/find">
          <FindFlow
            initialNote={entry.note}
            initialMode={entry.mode}
            initialZip={entry.zip}
            initialDistanceMiles={entry.distanceMiles}
          />
        </SignInGate>
      </div>
    </div>
  );
}
