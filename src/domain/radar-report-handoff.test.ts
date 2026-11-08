import { describe, expect, it } from "vitest";
import { vinDetailGaps } from "@/domain/vin-report";
import { buildRadarReportPayload } from "./radar-report-handoff";

describe("Radar full-report handoff carries known price + miles", () => {
  it("failure-first: VIN + zip alone still gaps asking price and mileage", () => {
    const thin = buildRadarReportPayload({ vin: "JM3KFBCM1K1514400", zip: "68114" });
    expect(vinDetailGaps({
      askingPriceUsd: thin.askingPriceUsd as number | undefined,
      miles: thin.miles as number | undefined,
      zip: thin.zip as string | undefined,
    })).toEqual(["asking price", "mileage"]);
  });

  it("row/alert facts fill asking price + miles so vin_needs_details does not fire for those fields", () => {
    const payload = buildRadarReportPayload({
      vin: "JM3KFBCM1K1514400",
      zip: "68114",
      priceUsd: 20_000,
      miles: 13_300,
      mode: "personal",
      year: 2019,
    });
    expect(payload).toMatchObject({
      vin: "JM3KFBCM1K1514400",
      selectedVin: "JM3KFBCM1K1514400",
      zip: "68114",
      askingPriceUsd: 20_000,
      miles: 13_300,
      year: 2019,
      surface: "radar",
      cta: "radar_full_report",
    });
    expect(
      vinDetailGaps({
        askingPriceUsd: payload.askingPriceUsd as number,
        miles: payload.miles as number,
        zip: payload.zip as string,
      }),
    ).toEqual([]);
  });

  it("does not invent price or miles from null/zero", () => {
    const payload = buildRadarReportPayload({
      vin: "JM3KFBCM1K1514400",
      zip: "68114",
      priceUsd: null,
      miles: null,
    });
    expect(payload.askingPriceUsd).toBeUndefined();
    expect(payload.miles).toBeUndefined();
  });
});
