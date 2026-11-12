import { describe, expect, it } from "vitest";
import { productFlagsUnavailableMessage, resolveProductFlags } from "./product-flags";

describe("resolveProductFlags", () => {
  it("keeps Resale and Deal Radar on; Scout and Telegram off (no env kill-switches)", () => {
    expect(resolveProductFlags({})).toEqual({
      resaleEvaluate: true,
      dealRadar: true,
      scout: false,
      telegram: false,
    });
    expect(
      resolveProductFlags({
        RESALE_EVALUATE_ENABLED: "false",
        DEAL_RADAR_UI_ENABLED: "0",
        SCOUT_UI_ENABLED: "yes",
        TELEGRAM_UI_ENABLED: "1",
      }),
    ).toEqual({
      resaleEvaluate: true,
      dealRadar: true,
      scout: false,
      telegram: false,
    });
  });

  it("unavailable copy points judges at Resale, not Telegram", () => {
    expect(productFlagsUnavailableMessage("dealRadar")).toMatch(/Resale/);
    expect(productFlagsUnavailableMessage("telegram")).toMatch(/not available/i);
    expect(productFlagsUnavailableMessage("telegram")).not.toMatch(/Connect Telegram/);
  });
});
