import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FREE_VEHICLE_CHECKS_PER_MONTH,
  formatFreeChecksRemaining,
  formatFreeChecksSignInPrompt,
  freeCheckQuotaView,
  freeCheckResetLabel,
  freeChecksRemainingFromAccount,
  nextUtcMonthResetIso,
} from "./free-check-quota";
import { ASSUMPTIONS } from "./assumptions";
import { assertBuyerSafeText } from "./find-buyer-copy";

describe("free-check-quota domain", () => {
  it("pins the monthly free allotment to existing assumptions (no invented prices)", () => {
    expect(FREE_VEHICLE_CHECKS_PER_MONTH).toBe(ASSUMPTIONS.freeVehicleChecksPerMonth);
    expect(FREE_VEHICLE_CHECKS_PER_MONTH).toBe(3);
  });

  it("exposes a clear UTC reset label for the consumer UI", () => {
    const now = new Date("2026-11-09T15:30:00.000Z");
    expect(nextUtcMonthResetIso(now)).toBe("2026-12-01T00:00:00.000Z");
    expect(freeCheckResetLabel(now)).toMatch(/1 December 2026 \(00:00 UTC\)/);
    const view = freeCheckQuotaView(1, now);
    expect(view.remaining).toBe(2);
    expect(view.resetsLabel).toBe(freeCheckResetLabel(now));
  });

  it("formats remaining checks and the UTC reset without recounting", () => {
    const now = new Date("2026-11-09T15:30:00.000Z");
    const twoLeft = freeCheckQuotaView(1, now);
    expect(formatFreeChecksRemaining(twoLeft)).toBe(
      "2 of 3 free checks left (resets 1 December 2026 (00:00 UTC))",
    );
    expect(formatFreeChecksRemaining(freeCheckQuotaView(0, now))).toBe(
      "3 of 3 free checks left (resets 1 December 2026 (00:00 UTC))",
    );
    expect(formatFreeChecksRemaining(freeCheckQuotaView(3, now))).toBe(
      "0 of 3 free checks left (resets 1 December 2026 (00:00 UTC))",
    );
    const yearEnd = new Date("2026-12-31T23:00:00.000Z");
    expect(formatFreeChecksRemaining(freeCheckQuotaView(2, yearEnd))).toBe(
      "1 of 3 free checks left (resets 1 January 2027 (00:00 UTC))",
    );
    expect(assertBuyerSafeText(formatFreeChecksRemaining(twoLeft)).ok).toBe(true);
    expect(formatFreeChecksSignInPrompt()).toBe(
      `Sign in to get ${FREE_VEHICLE_CHECKS_PER_MONTH} free checks a month`,
    );
    expect(formatFreeChecksSignInPrompt().startsWith("Sign in")).toBe(true);
  });

  it("shows a server payload as-is and does not invent a count when it is missing", () => {
    const line = freeChecksRemainingFromAccount({
      authenticated: true,
      freeChecks: { remaining: 2, limit: 3, resetsLabel: "1 December 2026 (00:00 UTC)" },
    });
    expect(line).toBe("2 of 3 free checks left (resets 1 December 2026 (00:00 UTC))");
    expect(freeChecksRemainingFromAccount({ authenticated: false, freeChecks: null })).toBe("signed-out");
    expect(freeChecksRemainingFromAccount({ authenticated: true, freeChecks: null })).toBe("missing");
    expect(freeChecksRemainingFromAccount({ authenticated: true, freeChecks: { remaining: 2 } })).toBe("missing");
  });

  it("account, check, and credits pages render that server line", () => {
    const account = readFileSync(path.join(process.cwd(), "src/components/AccountPanel.tsx"), "utf8");
    const check = readFileSync(path.join(process.cwd(), "src/components/AssistantFlow.tsx"), "utf8");
    const credits = readFileSync(path.join(process.cwd(), "src/app/credits/page.tsx"), "utf8");
    expect(account).toMatch(/freeChecksRemainingFromAccount/);
    expect(check).toMatch(/freeChecksRemainingFromAccount/);
    expect(check).toMatch(/formatFreeChecksSignInPrompt/);
    expect(check).toMatch(/fetch\(["']\/api\/account["']\)/);
    expect(credits).toMatch(/freeChecksRemainingFromAccount/);
  });
});
