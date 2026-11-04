import fixture from "../../fixtures/autodev-camry.json";
import { parseAutoDevListings } from "./parsers";
import type { Listing } from "@/domain/types";

let cached: Listing[] | null = null;

export function sampleListings(): Listing[] {
  if (!cached) cached = parseAutoDevListings(fixture, "sample");
  return cached;
}

export function sampleByVin(vin: string): Listing | null {
  return sampleListings().find((item) => item.vin === vin.toUpperCase()) ?? null;
}
