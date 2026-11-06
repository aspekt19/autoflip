import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MemoryKv } from "@/io/kv";

describe("requirePaidAccess", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("@/auth");
    vi.doUnmock("@/io/kv");
    delete process.env.AUTH_SECRET;
    delete process.env.AUTH_GOOGLE_ID;
    delete process.env.AUTH_GOOGLE_SECRET;
    delete process.env.AUTH_EMAIL_MODE;
  });

  it("fails closed when auth is not configured", async () => {
    const { requirePaidAccess } = await import("@/server/session");
    const result = await requirePaidAccess();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
    const body = await result.response.json();
    expect(body.error).toBe("auth_unconfigured");
  });

  it("denies missing session when auth is configured", async () => {
    process.env.AUTH_SECRET = "test-secret-at-least-32-chars-long!!";
    process.env.AUTH_EMAIL_MODE = "test";
    vi.doMock("@/auth", () => ({
      auth: async () => null,
    }));
    const { requirePaidAccess } = await import("@/server/session");
    const result = await requirePaidAccess();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
  });

  it("denies unverified email sessions", async () => {
    process.env.AUTH_SECRET = "test-secret-at-least-32-chars-long!!";
    process.env.AUTH_EMAIL_MODE = "test";
    vi.doMock("@/auth", () => ({
      auth: async () => ({
        user: {
          id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          email: "user@example.com",
          emailVerified: null,
        },
      }),
    }));
    const { requirePaidAccess } = await import("@/server/session");
    const result = await requirePaidAccess();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    const body = await result.response.json();
    expect(body.error).toBe("email_unverified");
  });

  it("allows verified sessions", async () => {
    process.env.AUTH_SECRET = "test-secret-at-least-32-chars-long!!";
    process.env.AUTH_EMAIL_MODE = "test";
    const kv = new MemoryKv();
    vi.doMock("@/io/kv", () => ({
      getKv: () => kv,
      storageMode: () => "file" as const,
      MemoryKv,
    }));
    vi.doMock("@/auth", () => ({
      auth: async () => ({
        user: {
          id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          email: "user@example.com",
          emailVerified: new Date("2026-01-01"),
        },
      }),
    }));
    const { requirePaidAccess } = await import("@/server/session");
    const result = await requirePaidAccess();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(result.email).toBe("user@example.com");
  });
});
