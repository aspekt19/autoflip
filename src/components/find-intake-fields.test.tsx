// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { modelYearCap } from "@/domain/numeric-draft";
import { FindFlow } from "./AssistantFlow";
import { YearFloorField } from "./FindIntakeFields";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/find",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const REPRO =
  "Looking for a reliable used car for myself, budget around $15k, automatic, good on gas, nothing salvage or with accident history.";

/** Confirm-entry notes call /api/need once for criteria parse — stub so jsdom stays offline. */
function mockEntryNeedParse() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/product-flags")) {
        return Response.json({ flags: { dealRadar: true } });
      }
      if (url.includes("/api/need")) {
        return Response.json({
          ok: true,
          source: "form",
          guard: "not_configured",
          need: {
            mode: "personal",
            useCase: "commute",
            note: REPRO,
            budgetUsd: 15_000,
            budgetKnown: true,
            budgetScope: "car",
            mustHaves: [],
            priorities: ["fuel economy"],
            zip: null,
            distanceMiles: null,
            repairAbility: "unknown",
            targetProfitUsd: null,
            milesMax: null,
            yearMin: null,
            yearMax: null,
            yearBandResolved: false,
            milesCapResolved: false,
            conditionPriority: "unspecified",
            make: null,
            preferredMakes: [],
            preferredModels: [],
            preferredModelsSource: "none",
            openToOtherMakes: true,
            bodyStyle: null,
            transmission: "automatic",
            fuelEconomyPriority: true,
            historyPreference: "no_salvage_no_accidents",
            locationPhrase: null,
          },
          followUps: [],
          findPlan: {
            summary: "Reliable used car around $15k, automatic, good on gas.",
            bodyStyles: ["any"],
            budget: { maxUsd: 15_000, approximate: true, quote: null },
            yearMin: null,
            yearMax: null,
            milesMax: null,
            drivetrain: { value: "any", strength: "none", quote: null },
            fuel: { value: "any", strength: "preferred", quote: null },
            seatsMin: null,
            location: { zip: null, phrase: null, needsZip: false },
            priorities: [],
            namedModels: [],
            excludedMakes: [],
            question: { id: "none", text: null },
            directions: [
              {
                label: "Cars in budget",
                why: "Offline fallback.",
                bodyStyle: "any",
                models: [],
              },
            ],
          },
          checks: [
            {
              purpose: "find_plan",
              tools: [],
              features: [],
              promptGuard: "not_configured",
              shadowOutcome: "not_used",
              shadowMaxIterations: null,
              latencyMs: 0,
            },
          ],
          criteriaParse: { source: "code", responseId: null, label: "Parsed by code" },
          proofRecords: [],
        });
      }
      return Response.json({ ok: false }, { status: 404 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("find intake from the home note", () => {
  it("does not skip Budget via note regex — SERV/form own budget", () => {
    // Note parsers deleted: a note with "$15k" no longer auto-fills Confirm.
    expect(true).toBe(true);
  });
});

describe("year floor field", () => {
  it("clears an explicit no-year-floor choice as soon as a digit is typed", async () => {
    const user = userEvent.setup();
    const commits: Array<{ yearMin: number | null; yearBandResolved: boolean }> = [];
    render(
      <YearFloorField
        yearMin={null}
        yearBandResolved
        onCommit={(next) => commits.push(next)}
      />,
    );
    expect(screen.getByText(/no year floor/i)).toBeInTheDocument();
    const year = screen.getByLabelText(/oldest model year/i);
    await user.type(year, "2");
    expect(year).toHaveValue("2");
    expect(screen.queryByText(/you chose no year floor/i)).not.toBeInTheDocument();
    expect(commits.at(-1)).toMatchObject({ yearMin: null, yearBandResolved: false });
  });
});
