import { describe, expect, it } from "vitest";
import {
  buildDecisionProofRecord,
  filterProofRecordsForOwner,
  NEED_PARSE_RUBRIC_ID,
  RADAR_VERDICT_RUBRIC_ID,
} from "./decision-proof-record";

describe("filterProofRecordsForOwner", () => {
  it("keeps only this owner's / search's radar proofs", () => {
    const mine = buildDecisionProofRecord({
      purpose: "verdict_decide",
      rubricId: RADAR_VERDICT_RUBRIC_ID,
      status: "ok",
      responseId: "chatcmpl-mine",
      inputs: { vin: "a" },
      verdict: "negotiate",
      searchId: "search-mine",
      ownerId: "owner-a",
    });
    const theirs = buildDecisionProofRecord({
      purpose: "verdict_decide",
      rubricId: RADAR_VERDICT_RUBRIC_ID,
      status: "ok",
      responseId: "chatcmpl-theirs",
      inputs: { vin: "b" },
      verdict: "buy",
      searchId: "search-theirs",
      ownerId: "owner-b",
    });
    const unscoped = buildDecisionProofRecord({
      purpose: "need_extract",
      rubricId: NEED_PARSE_RUBRIC_ID,
      status: "ok",
      responseId: "chatcmpl-x",
      inputs: { t: 1 },
      verdict: "extracted",
    });
    const filtered = filterProofRecordsForOwner([mine, theirs, unscoped], {
      ownerId: "owner-a",
      searchIds: new Set(["search-mine"]),
    });
    expect(filtered).toEqual([mine]);
    expect(filtered.some((row) => row.servResponseId === "chatcmpl-theirs")).toBe(false);
  });
});
