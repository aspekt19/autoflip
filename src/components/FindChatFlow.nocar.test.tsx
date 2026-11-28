// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ServChatDonePayload } from "./ServChat";

const payload: ServChatDonePayload = {
  sessionId: "s1",
  messages: [],
  charged: true,
  result: {
    runId: "run_abc",
    bestDeal: { ranked: [], pick: null },
    pickAgentVerdict: null,
    offerPool: [],
    honesty: "No car met the brief in this search, so no car was chosen and nothing was published.",
  },
};

vi.mock("./ServChat", () => ({
  ServChat: ({ onDone }: { onDone: (p: ServChatDonePayload) => void }) => {
    onDone(payload);
    return null;
  },
}));
vi.mock("./ServDecisionJournal", () => ({ ServDecisionJournal: () => null }));

afterEach(cleanup);

describe("Find with no shortlist", () => {
  it("says no car was chosen and hides the match report link", async () => {
    const { FindChatFlow } = await import("./FindChatFlow");
    render(<FindChatFlow />);
    expect(screen.getByText(/did not choose a car/i)).toBeInTheDocument();
    expect(screen.queryByText(/Open match report/)).toBeNull();
    expect(screen.queryByText(/tentative pick|pick was published/i)).toBeNull();
  });
});
