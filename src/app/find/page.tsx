import type { Metadata } from "next";
import { FindFlow } from "@/components/AssistantFlow";
import { parseDistanceMiles } from "@/domain/need";

export const metadata: Metadata = { title: "Find a car" };

export default async function FindPage({
  searchParams,
}: {
  searchParams: Promise<{ note?: string; mode?: string; zip?: string; distanceMiles?: string }>;
}) {
  const params = await searchParams;
  const zip = typeof params.zip === "string" && /^\d{5}$/.test(params.zip.trim()) ? params.zip.trim() : undefined;
  const distanceParsed = parseDistanceMiles(params.distanceMiles);
  const distanceMiles = distanceParsed.ok ? distanceParsed.miles : undefined;
  // Radius without ZIP cannot be applied — leave both unset rather than silently nationwide-widening.
  const initialZip = distanceMiles != null && !zip ? undefined : zip;
  const initialDistanceMiles = distanceMiles != null && !zip ? undefined : distanceMiles;

  return (
    <div className="sub">
      <div className="flow-page">
        <p className="kicker">Help me choose</p>
        <h1>What kind of car do you need?</h1>
        <div className="onboarding-note">
          <strong>How this works</strong>
          <ol>
            <li>Describe the car and your budget.</li>
            <li>Review matching dealer listings. The search is free.</li>
            <li>Open a full report for any car you want to investigate further. It costs 1 report credit.</li>
          </ol>
          <p>Use a U.S. ZIP code and seller-distance radius to find nearby listings. Deal Radar is a separate optional monthly plan.</p>
        </div>
        <FindFlow
          initialNote={params.note}
          initialMode={params.mode === "flip" ? "flip" : "personal"}
          initialZip={initialZip}
          initialDistanceMiles={initialDistanceMiles}
        />
      </div>
    </div>
  );
}
