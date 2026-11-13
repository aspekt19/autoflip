import { describe, expect, it } from "vitest";
import {
  SERV_CHAT_MAX_MESSAGE_CHARS,
  SERV_CHAT_MAX_USER_TURNS,
  SERV_TOPIC_SCOPE_RULE,
  chatLimitViolation,
  checkBudgetUserQuote,
  formatShopperBriefCard,
  parseShopperBrief,
} from "./shopper-brief";

describe("checkBudgetUserQuote", () => {
  const transcript = "Shopper: Looking for an SUV under $25k near Austin.\n\nSERV: Got it.";

  it("null when both empty", () => {
    expect(checkBudgetUserQuote({ maxUsd: null, userQuote: null }, transcript)).toEqual({
      ok: true,
      status: "null",
    });
  });

  it("valid when quote is verbatim and maxUsd matches", () => {
    expect(
      checkBudgetUserQuote({ maxUsd: 25_000, userQuote: "under $25k" }, transcript),
    ).toEqual({ ok: true, status: "valid" });
  });

  it("fabricated when quote is not in transcript", () => {
    const r = checkBudgetUserQuote({ maxUsd: 25_000, userQuote: "max twenty five thousand" }, transcript);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("fabricated");
  });

  it("fabricated when maxUsd set without quote", () => {
    const r = checkBudgetUserQuote({ maxUsd: 25_000, userQuote: null }, transcript);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("fabricated");
  });

  it("mismatch when quote is present but maxUsd disagrees", () => {
    const r = checkBudgetUserQuote({ maxUsd: 40_000, userQuote: "under $25k" }, transcript);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("mismatch");
  });
});

describe("parseShopperBrief + card", () => {
  it("parses a compact brief", () => {
    const parsed = parseShopperBrief({
      summary: "Family SUV near Austin",
      budget: { maxUsd: 25_000, userQuote: "under $25k" },
      zip: "78701",
      radiusMi: 50,
      notes: null,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(formatShopperBriefCard(parsed.brief)).toMatch(/Budget: \$25,000/);
  });

  it("keeps SERV-emitted hard/soft constraints without chat parsing", () => {
    const parsed = parseShopperBrief({
      summary: "Sedan under 15k",
      budget: { maxUsd: 15_000, userQuote: "15k" },
      zip: "97201",
      radiusMi: 75,
      notes: null,
      hardConstraints: [{ key: "transmission", value: "automatic" }],
      softConstraints: [{ key: "color", value: "blue OK" }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.brief.hardConstraints?.[0]?.key).toBe("transmission");
    expect(formatShopperBriefCard(parsed.brief)).toMatch(/Hard: transmission=automatic/);
  });
});

describe("chat abuse limits (content-agnostic)", () => {
  it("trips on max chars without needing SERV", () => {
    const r = chatLimitViolation({
      message: "x".repeat(SERV_CHAT_MAX_MESSAGE_CHARS + 1),
      messages: [],
      addingUserMessage: true,
    });
    expect(r.ok).toBe(false);
  });

  it("trips on max user turns", () => {
    const messages = Array.from({ length: SERV_CHAT_MAX_USER_TURNS }, () => ({ role: "user" }));
    const r = chatLimitViolation({
      message: "one more",
      messages,
      addingUserMessage: true,
    });
    expect(r.ok).toBe(false);
  });

  it("does not classify topics — off-topic text is allowed at the limit layer", () => {
    const r = chatLimitViolation({
      message: "Write me a poem about quantum physics homework",
      messages: [],
      addingUserMessage: true,
    });
    expect(r.ok).toBe(true);
  });
});

describe("topic scope rule (SERV instructions, not code filter)", () => {
  it("states Lemonless car scope and no tools off-topic", () => {
    expect(SERV_TOPIC_SCOPE_RULE).toMatch(/Lemonless car scope/i);
    expect(SERV_TOPIC_SCOPE_RULE).toMatch(/do not call tools/i);
    expect(SERV_TOPIC_SCOPE_RULE).toMatch(/submit_brief/i);
  });
});
