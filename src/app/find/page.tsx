import type { Metadata } from "next";
import { FindFlow } from "@/components/AssistantFlow";
import { parseFindEntryParams } from "@/domain/need";

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
      <div className="flow-page">
        <p className="kicker">Help me choose</p>
        <h1>What kind of car do you need?</h1>
        <div className="onboarding-note">
          <strong>How this works</strong>
          <ol>
            <li>Describe the car and your budget.</li>
            <li>Add a U.S. ZIP and seller-distance radius when you want nearby listings — or choose Nationwide.</li>
            <li>Review matching dealer listings. Find search costs 1 report credit. Open a full report for any car you want to investigate further (another 1 report credit).</li>
          </ol>
          <p>Deal Radar is a separate optional monthly plan.</p>
        </div>
        <FindFlow
          initialNote={entry.note}
          initialMode={entry.mode}
          initialZip={entry.zip}
          initialDistanceMiles={entry.distanceMiles}
        />
      </div>
    </div>
  );
}
