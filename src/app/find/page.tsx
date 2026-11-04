import { FindFlow } from "@/components/AssistantFlow";

export default function FindPage() {
  return (
    <div className="sub">
      <div className="flow-page">
        <p className="kicker">Help me choose</p>
        <h1>What kind of car do you need?</h1>
        <FindFlow />
      </div>
    </div>
  );
}
