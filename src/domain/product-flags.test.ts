import { describe, expect, it } from "vitest";
import { productFlagsUnavailableMessage, resolveProductFlags } from "./product-flags";

describe("resolveProductFlags", () => {
  it("defaults: resale on, radar/scout/telegram off", () => {
    expect(resolveProductFlags({})).toEqual({
      resaleEvaluate: true,
      dealRadar: false,
      scout: false,
      telegram: false,
    });
  });

  it("enables radar and telegram only with explicit flags", () => {
    expect(
      resolveProductFlags({
        DEAL_RADAR_UI_ENABLED: "true",
        TELEGRAM_UI_ENABLED: "1",
        SCOUT_UI_ENABLED: "yes",
      }),
    ).toEqual({
      resaleEvaluate: true,
      dealRadar: true,
      scout: true,
      telegram: true,
    });
  });

  it("can turn resale evaluate off", () => {
    expect(resolveProductFlags({ RESALE_EVALUATE_ENABLED: "false" }).resaleEvaluate).toBe(false);
  });

  it("unavailable copy points judges at Resale, not Telegram", () => {
    expect(productFlagsUnavailableMessage("dealRadar")).toMatch(/Resale/);
    expect(productFlagsUnavailableMessage("telegram")).toMatch(/not available/i);
    expect(productFlagsUnavailableMessage("telegram")).not.toMatch(/Connect Telegram/);
  });
});

