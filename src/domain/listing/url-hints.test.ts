import { describe, expect, it } from "vitest";
import { listingUrlHints, listingUrlHintsSummary } from "./url-hints";

describe("listingUrlHints", () => {
  it("extracts cars.com vehicle detail UUID (prod-style VDP)", () => {
    const hints = listingUrlHints(
      "https://www.cars.com/vehicledetail/39a91db4-14e9-4a6e-82f5-34589631ba2d/",
    );
    expect(hints.site).toBe("cars.com");
    expect(hints.listingId).toBe("39a91db4-14e9-4a6e-82f5-34589631ba2d");
    expect(hints.vin).toBeNull();
    expect(hints.ymm).toBeNull();
  });

  it("extracts Autotrader vehicle id from /cars-for-sale/vehicle/{id}", () => {
    const hints = listingUrlHints("https://www.autotrader.com/cars-for-sale/vehicle/756212296");
    expect(hints.site).toBe("autotrader.com");
    expect(hints.listingId).toBe("756212296");
    expect(hints.vin).toBeNull();
    expect(hints.ymm).toBeNull();
  });

  it("extracts YMM from Autotrader search slug paths", () => {
    const hints = listingUrlHints(
      "https://www.autotrader.com/cars-for-sale/hatchback/2020/honda/civic",
    );
    expect(hints.site).toBe("autotrader.com");
    expect(hints.ymm).toMatchObject({ year: 2020, make: "honda", model: "civic" });
  });

  it("extracts CarGurus / CarMax / Carvana listing ids", () => {
    expect(listingUrlHints("https://www.cargurus.com/details/447774678").listingId).toBe("447774678");
    expect(listingUrlHints("https://www.carmax.com/car/70163746").listingId).toBe("70163746");
    expect(listingUrlHints("https://www.carvana.com/vehicle/4802365").listingId).toBe("4802365");
  });

  it("summarizes URL-only evidence without inventing facts", () => {
    expect(
      listingUrlHintsSummary(
        listingUrlHints("https://www.cars.com/vehicledetail/39a91db4-14e9-4a6e-82f5-34589631ba2d/"),
      ),
    ).toMatch(/cars\.com.*listing id 39a91db4/i);
  });
});
