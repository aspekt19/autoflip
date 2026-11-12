// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { emptyAgentVerdict } from "@/domain/agent-verdict-schema";
import { CREDIT_BALANCE_EVENT } from "@/domain/credit-balance-event";
import { Header } from "./Header";
import { ResaleFlow } from "./ResaleFlow";
import { ZipRadiusFields } from "./ZipRadiusFields";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/resale",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const RADII = ["25 miles", "50 miles", "75 miles", "100 miles", "150 miles", "250 miles"];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("seller distance presets", () => {
  it("offers the same common radii on Find and Resale", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <ZipRadiusFields zip="" distanceMiles={null} onZipChange={() => {}} onDistanceChange={() => {}} />,
    );
    const findRadius = screen.getByLabelText(/seller distance radius/i);
    expect(Array.from((findRadius as HTMLSelectElement).options).map((option) => option.text)).toEqual([
      "Nationwide",
      ...RADII,
      "Custom…",
    ]);
    unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/account")) {
          return Response.json({
            authenticated: true,
            credits: 5,
            auth: { configured: true },
            email: "buyer@example.com",
          });
        }
        return Response.json({});
      }),
    );
    render(<ResaleFlow />);
    await user.click(await screen.findByRole("button", { name: /optional filters/i }));
    const resaleRadius = await screen.findByLabelText(/radius \(miles\)/i);
    expect(Array.from((resaleRadius as HTMLSelectElement).options).map((option) => option.text)).toEqual([
      "Nationwide",
      ...RADII,
    ]);
    expect(screen.getByText(/if no cars match, you get that explanation and no verdict/i)).toBeInTheDocument();
    expect(screen.queryByText(/dead end/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/verdict every time/i)).not.toBeInTheDocument();
  });

  it("shows a finished resale result instead of the form and refetches the credit balance", async () => {
    const user = userEvent.setup();
    const balances: number[] = [];
    function onBalance(event: Event) {
      balances.push((event as CustomEvent<number>).detail);
    }
    window.addEventListener(CREDIT_BALANCE_EVENT, onBalance);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/account")) {
          return Response.json({ authenticated: true, credits: 5, auth: { configured: true } });
        }
        if (url.includes("/api/resale/search")) {
          return Response.json({
            done: true,
            agentVerdict: emptyAgentVerdict(),
            confidence: "Low",
            verdictAction: "pass",
            verdictLabel: "No cars matched",
            message: "No cars matched this search, so there is no verdict and nothing was charged.",
            headline: "No cars matched",
            nextStepHint: "Try a wider radius.",
            creditNote: "No credit was used.",
            balance: 2,
            budgetUsd: 8000,
            best: null,
            alternatives: [],
            journal: { schemaVersion: "lemonless.resale_journal.v1", steps: [], servCalls: 0 },
            proofRecords: [],
          });
        }
        return Response.json({});
      }),
    );
    render(<ResaleFlow />);
    const budget = await screen.findByLabelText(/budget \(required\)/i);
    await user.type(budget, "8000");
    await user.click(screen.getByRole("button", { name: /find flips/i }));
    expect(await screen.findByRole("button", { name: "New search" })).toBeInTheDocument();
    expect(screen.getByText(/no cars matched this search/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/budget \(required\)/i)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(balances.length).toBeGreaterThan(0);
    });
    expect(balances.every((value) => value === 5)).toBe(true);
    await user.click(screen.getByRole("button", { name: "New search" }));
    expect(await screen.findByLabelText(/budget \(required\)/i)).toBeInTheDocument();
    window.removeEventListener(CREDIT_BALANCE_EVENT, onBalance);
  });

  it("refetches the header balance when the page regains focus", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/account")) {
        return Response.json({ authenticated: true, credits: 4, auth: { configured: true } });
      }
      if (url.includes("/api/product-flags")) {
        return Response.json({ flags: { resaleEvaluate: true, dealRadar: false, scout: false, telegram: false } });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Header />);
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/account")).length).toBeGreaterThan(0);
    });
    const before = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/account")).length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/account")).length).toBeGreaterThan(before);
    });
  });
});
