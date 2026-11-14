import { describe, expect, it, vi } from "vitest";
import { createFindRecordingFetch, createFindReplayFetch, type FindReplayCassette } from "./replay-cassette";

describe("Find tool HTTP replay cassette", () => {
  it("records and replays an exact request without another network call", async () => {
    const liveFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ rows: [1] }), { status: 200, headers: { "content-type": "application/json" } }));
    const recorder = createFindRecordingFetch(liveFetch);
    const url = "https://api.auto.dev/listings?zip=80202&limit=20";
    const liveResponse = await recorder.fetch(url);
    expect(await liveResponse.json()).toEqual({ rows: [1] });
    const replay = createFindReplayFetch(recorder.cassette());
    const replayResponse = await replay.fetch(url);
    expect(await replayResponse.json()).toEqual({ rows: [1] });
    replay.assertConsumed();
    expect(liveFetch).toHaveBeenCalledTimes(1);
    expect(replay.events.map((event) => event.kind)).toEqual(["replayed"]);
  });

  it("fails closed for a request absent from the cassette", async () => {
    const replay = createFindReplayFetch({ schemaVersion: 1, entries: [] });
    await expect(replay.fetch("https://api.auto.dev/listings?zip=80202")).rejects.toThrow("Find replay cassette miss");
    expect(replay.events.map((event) => event.kind)).toEqual(["miss"]);
  });

  it("rejects a cassette whose request hash was changed", () => {
    const cassette: FindReplayCassette = {
      schemaVersion: 1,
      entries: [{ key: "wrong", request: { method: "GET", url: "https://api.auto.dev/listings", headers: [], body: "" }, response: { kind: "response", status: 200, statusText: "OK", headers: [], body: "{}" } }],
    };
    expect(() => createFindReplayFetch(cassette)).toThrow("request hash mismatch");
  });

  it("requires every recorded response to be consumed", async () => {
    const recorder = createFindRecordingFetch(async () => new Response("{}", { status: 200 }));
    await recorder.fetch("https://api.auto.dev/listings");
    const replay = createFindReplayFetch(recorder.cassette());
    expect(() => replay.assertConsumed()).toThrow("unused response");
  });
});
