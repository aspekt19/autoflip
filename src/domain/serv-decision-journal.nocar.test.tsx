// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ServDecisionJournal } from "@/components/ServDecisionJournal";
import type { ServDecisionJournalView } from "@/domain/serv-decision-step";

afterEach(cleanup);

const journal: ServDecisionJournalView = {
  schemaVersion: "lemonless.serv_decision_journal.v1",
  title: "How this decision was made",
  steps: [],
  servUsed: false,
  secondCheck: {
    status: "not_run",
    answersAgree: null,
    detail: "No car was chosen: the search found no cars that meet the brief.",
    modelId: "find_graph_decide",
    runId: null,
    role: "graph_fallback",
    noCar: true,
  },
};

describe("decision journal with no car", () => {
  it("hides the saved-decision links and the tentative-pick copy", () => {
    const { container } = render(<ServDecisionJournal journal={journal} verifyId="run_abc" defaultOpen />);
    expect(screen.queryByText(/Check this saved decision/)).toBeNull();
    expect(screen.queryByText(/Check a saved decision/)).toBeNull();
    expect(container.textContent).not.toMatch(/tentative pick|pick was published/i);
    expect(container.textContent).toMatch(/no car was chosen/i);
  });
});
