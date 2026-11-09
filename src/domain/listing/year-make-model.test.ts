import { describe, expect, it } from "vitest";
import { joinSummarySentences, yearMakeModelFromSlug, yearMakeModelFromText } from "./year-make-model";

describe("yearMakeModel helpers", () => {
  it("parses title text including CR-V", () => {
    expect(yearMakeModelFromText("2015 Honda CR-V EX AWD for sale")).toMatchObject({
      year: 2015,
      make: "Honda",
      model: "CR-V",
    });
  });

  it("parses used-YYYY-make-model URL slugs without gluing trim onto model", () => {
    expect(
      yearMakeModelFromSlug(
        "https://www.cruz.com/inventory/used-2015-honda-cr-v-ex-awd-2hkrm4h75fh111111",
      ),
    ).toMatchObject({
      year: 2015,
      make: "honda",
      model: "cr-v",
    });
    expect(yearMakeModelFromSlug("https://dealer.example/inventory/2021-Toyota-Camry-SE")).toMatchObject({
      year: 2021,
      make: "Toyota",
      model: "Camry",
      trim: "SE",
    });
  });

  it("joins summary sentences without a double period", () => {
    expect(
      joinSummarySentences([
        "2014 Toyota Camry LE",
        "At the market price, based on 20 similar listings.",
        "Review the red flags and seller questions below",
      ]),
    ).toBe(
      "2014 Toyota Camry LE. At the market price, based on 20 similar listings. Review the red flags and seller questions below.",
    );
    expect(joinSummarySentences(["Done."])).toBe("Done.");
  });
});
