/**
 * SearchDirection shape for SERV find_plan → UI / journal mapping.
 * Hardcoded make/model catalogs and note→body proposeDirections are deleted —
 * SERV owns what to search via search_listings.
 */
export type CandidateModel = { make: string; model: string };

export type SearchDirection = {
  id: string;
  segment: string;
  why: string;
  guidance: "editorial";
  yearMin: number;
  yearMax: number;
  yearBecause: string;
  models: CandidateModel[];
  /** The one make/model this direction will actually query. */
  search: CandidateModel;
  /** Optional Auto.dev vehicle.bodyStyle when the plan is body-led. */
  bodyStyle?: string;
};

export const MAX_DIRECTIONS = 3;

/** Stable direction id from the segment label (not useCase-N). */
export function directionIdFromSegment(segment: string, index = 0): string {
  const slug = segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `direction-${index + 1}`;
}
