import { describe, expect, it } from "vitest";
import {
  fuelConflictNote,
  isPlausibleSellerName,
  isSoldAvailability,
  normalizeAvailability,
  normalizeDrivetrain,
  normalizeFuelLabel,
} from "./schema-org";

describe("schema.org normalization", () => {
  it("maps FrontWheelDriveConfig URLs to FWD", () => {
    expect(normalizeDrivetrain("https://schema.org/FrontWheelDriveConfig")).toBe("FWD");
    expect(normalizeDrivetrain("https://schema.org/AllWheelDriveConfiguration")).toBe("AWD");
    expect(normalizeDrivetrain({ "@id": "https://schema.org/RearWheelDriveConfig" })).toBe("RWD");
  });

  it("maps SoldOut availability and detects SOLD", () => {
    expect(normalizeAvailability("https://schema.org/SoldOut")).toBe("SOLD");
    expect(isSoldAvailability("SOLD")).toBe(true);
    expect(isSoldAvailability("https://schema.org/SoldOut")).toBe(true);
    expect(isSoldAvailability("In stock")).toBe(false);
    expect(isSoldAvailability("This car has not been sold")).toBe(false);
  });

  it("drops junk seller names from page chrome", () => {
    expect(isPlausibleSellerName("ship Why trust Auto Boutique")).toBe(false);
    expect(isPlausibleSellerName("Sunrise Toyota of Miami")).toBe(true);
  });

  it("flags hybrid vs gasoline fuel conflicts and prefers decoder wording", () => {
    expect(fuelConflictNote("Hybrid", "Gasoline")).toMatch(/conflicts/i);
    expect(fuelConflictNote("Hybrid", "Gasoline")).toMatch(/as reported/i);
    expect(fuelConflictNote("Hybrid", "Gasoline")).not.toMatch(/Using the VIN decoder/i);
    expect(fuelConflictNote("Gasoline", "Gasoline")).toBeNull();
    expect(normalizeFuelLabel("https://schema.org/Hybrid")).toBe("Hybrid");
  });
});
