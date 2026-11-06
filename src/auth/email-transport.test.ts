import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { sendMagicLinkEmail, readTestInbox } from "./email-transport";

describe("magic link transport", () => {
  it("writes to test inbox outside production", async () => {
    const kv = new MemoryKv();
    await sendMagicLinkEmail({
      kv,
      to: "dev@example.com",
      url: "http://localhost/api/auth/callback/email?token=x",
      env: { AUTH_EMAIL_MODE: "test", NODE_ENV: "development" },
    });
    const mail = await readTestInbox(kv, "dev@example.com");
    expect(mail?.url).toContain("token=x");
  });

  it("hard-refuses test inbox in production even if AUTH_EMAIL_MODE=test", async () => {
    const kv = new MemoryKv();
    await expect(
      sendMagicLinkEmail({
        kv,
        to: "prod@example.com",
        url: "http://example.com/link",
        env: { AUTH_EMAIL_MODE: "test", NODE_ENV: "production", VERCEL_ENV: "production" },
      }),
    ).rejects.toThrow(/email_test_mode_forbidden_in_production/);
    expect(await readTestInbox(kv, "prod@example.com")).toBeNull();
  });
});
