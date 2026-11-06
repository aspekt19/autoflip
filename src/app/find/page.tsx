import type { Metadata } from "next";
import { FindFlow } from "@/components/AssistantFlow";

export const metadata: Metadata = { title: "Find a car" };

export default async function FindPage({ searchParams }: { searchParams: Promise<{ note?: string; mode?: string }> }) {
  const params = await searchParams;
  return (
    <div className="sub">
      <div className="flow-page">
        <p className="kicker">Help me choose</p>
        <h1>What kind of car do you need?</h1>
        <div className="onboarding-note"><strong>How this works</strong><ol><li>Describe the car and your budget.</li><li>Review matching dealer listings. The search is free.</li><li>Open a full report for any car you want to investigate further. It costs 1 report credit.</li></ol><p>Use a U.S. ZIP code to find nearby listings. Deal Radar is a separate optional monthly plan.</p></div>
        <FindFlow initialNote={params.note} initialMode={params.mode === "flip" ? "flip" : "personal"} />
      </div>
    </div>
  );
}
