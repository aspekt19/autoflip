// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { RunView } from "@/domain/run-view";
import { RunReport } from "./RunReport";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

function run(partial: Partial<RunView>): RunView {
  return {
    id: "run-1",
    kind: "find",
    phase: "stopped",
    viewerIsOwner: false,
    permalink: "/run/run-1",
    note: "a reliable car",
    clarifications: [],
    limits: [],
    verdict: null,
    confidence: null,
    confidenceReason: null,
    creditsCharged: 0,
    failureReasons: ["no_cars"],
    buyerMessage: "No cars matched this search, so there is no verdict and nothing was charged.",
    steps: [],
    sources: [],
    listings: [],
    picks: [],
    ...partial,
  };
}

afterEach(() => {
  cleanup();
});

describe("RunReport layout", () => {
  it("shows the no-cars result without a car heading or an empty car list", () => {
    const { container } = render(<RunReport run={run({})} />);
    expect(screen.getByRole("link", { name: "New search" })).toHaveAttribute("href", "/find");
    expect(screen.getByText(/no cars matched/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
    expect(container.querySelector(".run-listings")).toBeNull();
    expect(container.querySelector(".run-car")).toBeNull();
  });

  it("renders one readable car title and no extra column when there is a single car", () => {
    const { container } = render(
      <RunReport
        run={run({
          kind: "resale",
          phase: "finished",
          verdict: "pass",
          failureReasons: [],
          buyerMessage: "No flip worth it here.",
          listings: [
            {
              vin: "1HGCM82633A004352",
              year: 2018,
              make: "Honda",
              model: "Civic",
              trim: null,
              priceUsd: 7500,
              miles: 42000,
              dealer: "Main Street Honda",
              vdp: "https://dealer.example/civic",
              city: "New York",
              state: "NY",
              picked: true,
            },
          ],
          picks: ["1HGCM82633A004352"],
        })}
      />,
    );
    const title = screen.getByRole("heading", { level: 2, name: /2018 Honda Civic/i });
    expect(title).toHaveClass("run-car-title");
    expect(container.querySelectorAll(".run-car")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "New search" })).toHaveAttribute("href", "/resale");
    expect(screen.getByText("No flip worth it here")).toBeInTheDocument();
  });
});
