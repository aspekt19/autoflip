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
        <FindFlow initialNote={params.note} initialMode={params.mode === "flip" ? "flip" : "personal"} />
      </div>
    </div>
  );
}
