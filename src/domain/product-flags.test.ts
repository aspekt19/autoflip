import { describe, expect, it } from "vitest";
import { productFlagsUnavailableMessage, resolveProductFlags } from "./product-flags";

describe("resolveProductFlags", () => {
  it("keeps Resale, Deal Radar, and Telegram on; Scout off (no env kill-switches)", () => {
    expect(resolveProductFlags({})).toEqual({
      resaleEvaluate: true,
      dealRadar: true,
      scout: false,
      telegram: true,
    });
    expect(
      resolveProductFlags({
        RESALE_EVALUATE_ENABLED: "false",
        DEAL_RADAR_UI_ENABLED: "0",
        SCOUT_UI_ENABLED: "yes",
        TELEGRAM_UI_ENABLED: "0",
      }),
    ).toEqual({
      resaleEvaluate: true,
      dealRadar: true,
      scout: false,
      telegram: true,
    });
  });

  it("unavailable copy points judges at Resale; telegram message is config-only", () => {
    expect(productFlagsUnavailableMessage("dealRadar")).toMatch(/Resale/);
    expect(productFlagsUnavailableMessage("telegram")).toMatch(/not configured/i);
    expect(productFlagsUnavailableMessage("telegram")).not.toMatch(/Connect Telegram/);
  });
});
