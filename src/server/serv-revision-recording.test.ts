import { describe, expect, it } from "vitest";
import { loadServRevisionRecording, parseServRevisionRecording } from "./serv-revision-recording";

describe("serv revision recording honesty", () => {
  it("rejects the old agent-written revision shape", () => {
    const result = parseServRevisionRecording({
      note: "Saved response bodies… They are not a live spend.",
      first: { verdict: "buy", note: "Ask sits under the fair value." },
      revised: { verdict: "negotiate", note: "Two newer comps arrived." },
      challenge: {
        agrees: false,
        action: "needs_inspection",
        objection: "Recall lookup was unavailable",
        evidenceIds: ["ev_recall_unavailable"],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_recording");
  });

  it("rejects recordings without live provenance", () => {
    const result = parseServRevisionRecording({
      schema: "lemonless.serv_revision_recording.v1",
      recordedAt: "2026-11-09T00:00:00.000Z",
      model: "gpt-5.4-mini",
      costUsd: null,
      costNote: null,
      subject: {},
      first: {
        request: { profile: "verdict_decide", model: "gpt-5.4-mini", user: "x" },
        rawResponse: JSON.stringify({ verdict: "buy", note: "ok" }),
        parsed: { verdict: "buy", note: "ok" },
      },
      revised: {
        request: { profile: "verdict_decide", model: "gpt-5.4-mini", user: "y" },
        rawResponse: JSON.stringify({ verdict: "negotiate", note: "changed" }),
        parsed: { verdict: "negotiate", note: "changed" },
      },
      challenge: {
        request: { profile: "verdict_challenge", model: "gpt-5.4-mini", user: "z" },
        rawResponse: JSON.stringify({
          agrees: false,
          action: "pass",
          objection: "test",
          evidenceIds: ["ev_ask"],
        }),
      },
      allowedEvidenceIds: ["ev_ask"],
      provenance: "not a live capture",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/provenance/i);
  });

  it("loads missing recording as not_recorded", () => {
    const result = loadServRevisionRecording("/tmp/lemonless-no-such-serv-revision.json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_recorded");
  });

  it("rejects a recording that has no OpenServ id", () => {
    const result = parseServRevisionRecording({
      schema: "lemonless.serv_revision_recording.v1",
      recordedAt: "2026-11-09T12:00:00.000Z",
      model: "gpt-5.4-mini",
      costUsd: null,
      costNote: null,
      subject: {},
      first: {
        request: { profile: "verdict_decide", model: "gpt-5.4-mini", user: "first" },
        rawResponse: JSON.stringify({ verdict: "buy", note: "Under fair value." }),
      },
      revised: {
        request: { profile: "verdict_decide", model: "gpt-5.4-mini", user: "revised" },
        rawResponse: JSON.stringify({ verdict: "negotiate", note: "Newer comps lowered the case." }),
      },
      challenge: {
        request: { profile: "verdict_challenge", model: "gpt-5.4-mini", user: "challenge" },
        rawResponse: JSON.stringify({
          agrees: true,
          action: "negotiate",
          objection: null,
          evidenceIds: [],
        }),
      },
      allowedEvidenceIds: ["ev_ask"],
      provenance: "Live capture via npm run eval:record-serv-revision",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/response id|run id/i);
  });

  it("accepts a well-formed live-shaped recording", () => {
    const result = parseServRevisionRecording({
      schema: "lemonless.serv_revision_recording.v1",
      recordedAt: "2026-11-09T12:00:00.000Z",
      model: "gpt-5.4-mini",
      costUsd: null,
      costNote: "unit test fixture — not for sample page",
      subject: { vin: "4T1KZ1AK4MU060006" },
      first: {
        request: { profile: "verdict_decide", model: "gpt-5.4-mini", user: "first" },
        rawResponse: JSON.stringify({ verdict: "buy", note: "Under fair value." }),
        openserv: { responseId: "synthetic-test-1" },
        parsed: { verdict: "buy", note: "Under fair value." },
      },
      revised: {
        request: { profile: "verdict_decide", model: "gpt-5.4-mini", user: "revised" },
        rawResponse: JSON.stringify({ verdict: "negotiate", note: "Newer comps lowered the case." }),
        openserv: { responseId: "synthetic-test-2" },
        parsed: { verdict: "negotiate", note: "Newer comps lowered the case." },
      },
      challenge: {
        request: { profile: "verdict_challenge", model: "gpt-5.4-mini", user: "challenge" },
        rawResponse: JSON.stringify({
          agrees: false,
          action: "needs_inspection",
          objection: "Recall lookup was unavailable.",
          evidenceIds: ["ev_recall_unavailable"],
        }),
        openserv: { responseId: "synthetic-test-3" },
      },
      allowedEvidenceIds: ["ev_recall_unavailable", "ev_fair_value"],
      provenance: "Live capture via npm run eval:record-serv-revision",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recording.first.parsed.verdict).toBe("buy");
    expect(result.recording.revised.parsed.verdict).toBe("negotiate");
    expect(result.challenge.status).not.toBe("not_run");
  });
});
