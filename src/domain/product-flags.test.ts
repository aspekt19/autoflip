import { describe, expect, it } from "vitest";
import { productFlagsUnavailableMessage, resolveProductFlags } from "./product-flags";

describe("resolveProductFlags", () => {
  it("defaults: resale and deal radar on; scout/telegram off", () => {
    expect(resolveProductFlags({})).toEqual({
      resaleEvaluate: true,
      dealRadar: true,
      scout: false,
      telegram: false,
    });
  });

  it("can turn deal radar off explicitly", () => {
    expect(resolveProductFlags({ DEAL_RADAR_UI_ENABLED: "false" }).dealRadar).toBe(false);
  });

  it("enables scout and telegram only with explicit flags", () => {
    expect(
      resolveProductFlags({
        SCOUT_UI_ENABLED: "yes",
        TELEGRAM_UI_ENABLED: "1",
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
