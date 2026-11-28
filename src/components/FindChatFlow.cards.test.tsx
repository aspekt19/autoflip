// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ServChatDonePayload } from "./ServChat";

const WINNER_VIN = "JTDS4MCE8NJ098790";
const CAMRY_VIN = "4T1BF1FK5HU644745";
const DECISION = "Fewer miles than the alternative and no reported accident.";

function car(vin: string, year: number, model: string, priceUsd: number, miles: number) {
  return {
    key: vin,
    vin,
    year,
    make: "Toyota",
    model,
    priceUsd,
    miles,
    score: 0,
    factors: [],
    unknowns: [],
    fuelSummary: null,
    excludedFromPick: false,
    excludedReason: null,
    sellerQuestions: [],
    drivetrain: "FWD",
    bodyStyle: "Car",
    style: "Sedan",
    distanceMiles: 10,
    radiusCheck: "known" as const,
  };
}

const winner = car(WINNER_VIN, 2022, "Corolla", 14_449, 42_923);
const camry = car(CAMRY_VIN, 2017, "Camry", 10_449, 83_000);

const payload: ServChatDonePayload = {
  sessionId: "s1",
  messages: [],
  charged: true,
  result: {
    bestDeal: { ranked: [winner, camry], pick: winner, why: "Best choice on current data: 2022 Toyota Corolla.", choice: { label: "2022 Toyota Corolla", runnerUpLabel: null, reasons: [DECISION], confidence: "medium", confidenceLine: "Medium", confirmBeforeBuying: [] } },
    pickAgentVerdict: { verdict: "needs_inspection", confidence: "medium", pick: { key: WINNER_VIN, label: "2022 Toyota Corolla" }, reasons: [{ evidenceId: `car:${WINNER_VIN}`, text: DECISION }] },
    offerPool: [],
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

describe("Find result cards", () => {
  it("shows the decision only on the winning card, a per-car note on the other, and Sedan for Car + Sedan", async () => {
    const { FindChatFlow } = await import("./FindChatFlow");
    render(<FindChatFlow />);
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(2);
    const [first, second] = cards as [HTMLElement, HTMLElement];

    expect(within(first).getByText(/Fewer miles than the alternative and no reported accident/)).toBeInTheDocument();
    expect(within(second).queryByText(/Fewer miles than the alternative/)).toBeNull();
    expect(within(first).queryByText(/Best choice on current data/)).toBeNull();
    expect(within(second).getByText(/Compared with the pick \(2022 Toyota Corolla\): asks \$4,000 less/)).toBeInTheDocument();

    expect(within(first).getByText(/Sedan · FWD/)).toBeInTheDocument();
    expect(within(second).getByText(/Sedan · FWD/)).toBeInTheDocument();
    expect(screen.queryByText(/^Car · FWD/)).toBeNull();
  });
});
