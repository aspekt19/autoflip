import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GoldenTransportError,
  createGoldenFetch,
  publicHeaders,
  redactSecrets,
  requestHash,
} from "./transport";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("golden transport", () => {
  it("drops auth headers and secret strings", () => {
    const headers = publicHeaders({
      Authorization: "Bearer super-secret-token",
      Accept: "application/json",
      "X-Api-Key": "another-secret-value",
    });
    expect(headers.authorization).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers.accept).toBe("application/json");
    expect(JSON.stringify(headers)).not.toContain("super-secret-token");
    const redacted = redactSecrets({ note: "Bearer super-secret-token", ok: true }, ["super-secret-token"]);
    expect(JSON.stringify(redacted)).not.toContain("super-secret-token");
  });

  it("hashes the request without the auth header", () => {
    const left = requestHash("POST", "https://inference-api.openserv.ai/v1/chat/completions", { model: "gpt-6.1-sol" });
    const right = requestHash("POST", "https://inference-api.openserv.ai/v1/chat/completions", { model: "gpt-6.1-sol" });
    expect(left).toBe(right);
    expect(left).not.toContain("Bearer");
  });

  it("fails an unseen hash once a recording exists, and does not invent one when the directory is empty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "golden-"));
    dirs.push(root);
    const empty = await createGoldenFetch({ mode: "replay", caseId: "G1", root, liveFetch: fetch });
    await expect(empty.fetch("https://api.auto.dev/listings?limit=20")).rejects.toBeInstanceOf(GoldenTransportError);
    expect(empty.pending).toBe(true);

    const recorded = await createGoldenFetch({
      mode: "record",
      caseId: "G1",
      root,
      secrets: ["super-secret-token"],
      liveFetch: async () =>
        Response.json({
          id: "chatcmpl-recorded",
          model: "gpt-6.1-sol",
          choices: [{ message: { content: "{}" } }],
        }),
    });
    await recorded.fetch("https://inference-api.openserv.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer super-secret-token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-6.1-sol", note: "hello" }),
    });
    const file = path.join(root, "G1", `${recorded.attempts[0]!.hash}.json`);
    const text = await readFile(file, "utf8");
    expect(text).not.toContain("super-secret-token");
    expect(text).not.toContain("Bearer");
    expect(text).toContain("gpt-6.1-sol");
    expect(text).toContain("chatcmpl-recorded");

    const replay = await createGoldenFetch({ mode: "replay", caseId: "G1", root });
    expect(replay.pending).toBe(false);
    const hit = await replay.fetch("https://inference-api.openserv.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer super-secret-token" },
      body: JSON.stringify({ model: "gpt-6.1-sol", note: "hello" }),
    });
    const body = (await hit.json()) as { id: string };
    expect(body.id).toBe("chatcmpl-recorded");
    await expect(
      replay.fetch("https://inference-api.openserv.ai/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6.1-sol", note: "different" }),
      }),
    ).rejects.toMatchObject({ code: "UNSEEN_REQUEST" });
  });
});
