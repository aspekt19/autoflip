import { afterEach, describe, expect, it } from "vitest";
import { POST } from "./route";

const PRIOR_CRON = process.env.CRON_SECRET;
const PRIOR_RADAR = process.env.RADAR_CRON_SECRET;

afterEach(() => {
  if (PRIOR_CRON === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = PRIOR_CRON;
  if (PRIOR_RADAR === undefined) delete process.env.RADAR_CRON_SECRET;
  else process.env.RADAR_CRON_SECRET = PRIOR_RADAR;
});

describe("POST /api/internal/eval-live auth", () => {
  it("returns unauthorized without a matching Bearer secret", async () => {
    process.env.CRON_SECRET = "eval-live-cron-test";
    delete process.env.RADAR_CRON_SECRET;
    const res = await POST(
      new Request("http://localhost/api/internal/eval-live", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("unauthorized");
  });

  it("returns not_configured when neither secret is set", async () => {
    delete process.env.CRON_SECRET;
    delete process.env.RADAR_CRON_SECRET;
    const res = await POST(
      new Request("http://localhost/api/internal/eval-live", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer anything",
        },
        body: "{}",
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("not_configured");
  });
});
