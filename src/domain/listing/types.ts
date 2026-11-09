/**
 * Listing-page extraction types for /check.
 * Every field carries provenance. Unknown stays null — never invented.
 */

export type ListingFieldSource =
  | "json_ld"
  | "open_graph"
  | "meta"
  | "microdata"
  | "visible_text"
  | "llm"
  | "url"
  | "pasted_text";

export type Provenanced<T> = {
  value: T | null;
  source: ListingFieldSource | null;
};

export type ExtractedListingFields = {
  priceUsd: Provenanced<number>;
  year: Provenanced<number>;
  make: Provenanced<string>;
  model: Provenanced<string>;
  trim: Provenanced<string>;
  miles: Provenanced<number>;
  vin: Provenanced<string>;
  transmission: Provenanced<string>;
  drivetrain: Provenanced<string>;
  fuel: Provenanced<string>;
  color: Provenanced<string>;
  location: Provenanced<string>;
  zip: Provenanced<string>;
  state: Provenanced<string>;
  sellerName: Provenanced<string>;
  listingDate: Provenanced<string>;
  description: Provenanced<string>;
  photoCount: Provenanced<number>;
  accidentsStated: Provenanced<string>;
  ownersStated: Provenanced<string>;
  titleStatus: Provenanced<string>;
  features: Provenanced<string[]>;
};

export type ListingParseLayer = {
  source: ListingFieldSource;
  fields: Partial<Record<keyof ExtractedListingFields, unknown>>;
  textSnippets: string[];
};

export type ListingPageParse = {
  url: string | null;
  title: string | null;
  layers: ListingParseLayer[];
  /** Plain text passed to the LLM step (redacted for injection phrases). */
  llmText: string;
  /** Deterministic merge before LLM (structured sources win over visible text). */
  deterministic: ExtractedListingFields;
};

export type ListingFetchOutcome =
  | {
      ok: true;
      url: string;
      finalUrl: string;
      status: number;
      html: string;
      fetchedAt: string;
    }
  | {
      ok: false;
      url: string;
      blocked: boolean;
      reason: string;
      status: number | null;
      fetchedAt: string;
    };

export type CheckConfidence = "High" | "Medium" | "Low";

export type CheckRedFlag = {
  id: string;
  level: "stop" | "caution" | "note";
  text: string;
  source: string;
};

export type CheckVerdictLabel =
  | "good_deal"
  | "fair"
  | "overpriced"
  | "walk_away"
  | "insufficient_data"
  | "dossier";

export function emptyField<T>(): Provenanced<T> {
  return { value: null, source: null };
}

export function emptyExtractedFields(): ExtractedListingFields {
  return {
    priceUsd: emptyField(),
    year: emptyField(),
    make: emptyField(),
    model: emptyField(),
    trim: emptyField(),
    miles: emptyField(),
    vin: emptyField(),
    transmission: emptyField(),
    drivetrain: emptyField(),
    fuel: emptyField(),
    color: emptyField(),
    location: emptyField(),
    zip: emptyField(),
    state: emptyField(),
    sellerName: emptyField(),
    listingDate: emptyField(),
    description: emptyField(),
    photoCount: emptyField(),
    accidentsStated: emptyField(),
    ownersStated: emptyField(),
    titleStatus: emptyField(),
    features: emptyField(),
  };
}
