import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const PRIOR_CRON = process.env.CRON_SECRET;
const PRIOR_RADAR = process.env.RADAR_CRON_SECRET;

afterEach(() => {
  if (PRIOR_CRON === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = PRIOR_CRON;
  if (PRIOR_RADAR === undefined) delete process.env.RADAR_CRON_SECRET;
  else process.env.RADAR_CRON_SECRET = PRIOR_RADAR;
});

describe("radar cron auth", () => {
  it("refuses the daily cron when CRON_SECRET is unset and no other secret matches", async () => {
    delete process.env.CRON_SECRET;
    delete process.env.RADAR_CRON_SECRET;
    const missing = await GET(new Request("http://localhost/api/radar/cron"));
    expect(missing.status).toBe(503);
    const body = (await missing.json()) as { error?: string };
    expect(body.error).toBe("not_configured");
  });

  it("accepts Authorization Bearer CRON_SECRET and rejects a different token", async () => {
    delete process.env.RADAR_CRON_SECRET;
    process.env.CRON_SECRET = "cron-name-only-test";
    const priorVercel = process.env.VERCEL;
    const priorUrl = process.env.UPSTASH_REDIS_REST_URL;
    const priorToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.VERCEL = "1";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    try {
      const wrong = await GET(
        new Request("http://localhost/api/radar/cron", { headers: { authorization: "Bearer other" } }),
      );
      expect(wrong.status).toBe(401);
      const authed = await GET(
        new Request("http://localhost/api/radar/cron", {
          headers: { authorization: "Bearer cron-name-only-test" },
        }),
      );
      expect(authed.status).toBe(503);
      const body = (await authed.json()) as { error?: string };
      expect(body.error).toBe("storage_not_configured");
    } finally {
      if (priorVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = priorVercel;
      if (priorUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = priorUrl;
      if (priorToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = priorToken;
    }
  });
});
