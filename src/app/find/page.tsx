import type { Metadata } from "next";
import { FindChatFlow } from "@/components/FindChatFlow";
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
        <h1>Chat with SERV</h1>
        <div className="onboarding-note">
          <strong>How this works</strong>
          <ol>
            <li>Describe the car you need in plain English.</li>
            <li>SERV asks whatever it needs, then searches live listings in the same chat.</li>
            <li>Review matching dealer listings. {FIND_PAGE_BILLING_STEP}</li>
          </ol>
          {resolveProductFlags().dealRadar ? (
            <p>
              Deal Radar watches require a paid plan (Radar $100/mo = 1 watch, Radar Pro $250/mo = 3 watches). Opening a full report still costs 1 credit.
            </p>
          ) : null}
        </div>
        <SignInGate callbackPath="/find">
          <FindChatFlow initialNote={entry.note} />
        </SignInGate>
      </div>
    </div>
  );
}
