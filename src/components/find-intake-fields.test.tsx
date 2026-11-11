// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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
  it("opens on Confirm with the note already filled in", () => {
    mockEntryNeedParse();
    render(<FindFlow initialNote={REPRO} initialMode="personal" />);
    expect(screen.getByRole("heading", { name: /what i understood/i })).toBeInTheDocument();
    expect(document.querySelector(".progress .is-current")).toHaveTextContent("Confirm");
    expect(screen.getByLabelText(/maximum vehicle price/i)).toHaveValue("15,000");
    expect(screen.getByLabelText("Transmission")).toHaveValue("automatic");
    expect(screen.getByLabelText("History")).toHaveValue("no_salvage_no_accidents");
    expect(screen.getByRole("checkbox", { name: /fuel economy/i })).toBeChecked();
    expect(screen.getAllByText(/from your note/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("checkbox", { name: /not sure yet/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/you chose no year floor/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/NMVTIS-approved history report/i)).not.toBeInTheDocument();
    const yearHint = document.getElementById("year-min-edit-hint");
    expect(yearHint?.textContent ?? "").not.toMatch(/\n/);
    expect((yearHint?.textContent ?? "").length).toBeLessThan(90);
  });

  it("lets the shopper type a model year without the field clearing", async () => {
    mockEntryNeedParse();
    const user = userEvent.setup();
    render(<FindFlow initialNote={REPRO} initialMode="personal" />);
    const year = screen.getByLabelText(/oldest model year/i);
    await user.type(year, "2016");
    expect(year).toHaveValue("2016");
    expect(screen.queryByText(/you chose no year floor/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a plain range error for a finished year and keeps the typed digits", async () => {
    mockEntryNeedParse();
    const user = userEvent.setup();
    render(<FindFlow initialNote={REPRO} initialMode="personal" />);
    const year = screen.getByLabelText(/oldest model year/i);
    await user.type(year, "1970");
    expect(year).toHaveValue("1970");
    expect(screen.getByRole("alert")).toHaveTextContent(/1980/);
    expect(screen.getByRole("alert")).toHaveTextContent(String(modelYearCap()));
    await user.clear(year);
    await user.type(year, "20");
    expect(year).toHaveValue("20");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.tab();
    expect(year).toHaveValue("20");
    expect(screen.getByRole("alert")).toHaveTextContent(/1980/);
  });

  it("keeps formatted price, mileage, ZIP, and custom radius text while typing", async () => {
    mockEntryNeedParse();
    const user = userEvent.setup();
    render(<FindFlow initialNote={REPRO} initialMode="personal" />);
    const price = screen.getByLabelText(/maximum vehicle price/i);
    await user.clear(price);
    await user.type(price, "$15,000");
    expect(price).toHaveValue("$15,000");

    const miles = screen.getByLabelText(/maximum mileage/i);
    await user.type(miles, "80,000");
    expect(miles).toHaveValue("80,000");

    const zip = screen.getByLabelText(/u\.s\. zip code/i);
    await user.type(zip, "02139");
    expect(zip).toHaveValue("02139");

    await user.selectOptions(screen.getByLabelText(/seller distance radius/i), "custom");
    const custom = screen.getByLabelText(/custom miles/i);
    await user.type(custom, "010");
    expect(custom).toHaveValue("010");
  });

  it("places Not sure yet in a checkbox row instead of a pill", () => {
    mockEntryNeedParse();
    render(<FindFlow initialNote="Looking for a reliable used car for commuting" initialMode="personal" />);
    const box = screen.getByRole("checkbox", { name: /not sure yet/i });
    expect(box.closest("label")).toHaveClass("check-line");
    expect(box.closest(".pill")).toBeNull();
    expect(screen.getByLabelText(/maximum vehicle price/i)).toBeEnabled();
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
