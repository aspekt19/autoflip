import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { KvAdapter } from "./kv-adapter";

describe("KvAdapter", () => {
  it("creates users, sessions, and one-use verification tokens", async () => {
    const kv = new MemoryKv();
    const adapter = KvAdapter(kv);
    const user = await adapter.createUser!({
      email: "owner@example.com",
      emailVerified: new Date("2026-01-01T00:00:00.000Z"),
      name: "Owner",
      image: null,
      id: "ignored",
    });
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await adapter.getUserByEmail!("owner@example.com")).toEqual(user);

    const session = await adapter.createSession!({
      sessionToken: "tok-1",
      userId: user.id,
      expires: new Date(Date.now() + 60_000),
    });
    const loaded = await adapter.getSessionAndUser!("tok-1");
    expect(loaded?.user.id).toBe(user.id);
    expect(loaded?.session.sessionToken).toBe(session.sessionToken);

    await adapter.createVerificationToken!({
      identifier: "owner@example.com",
      token: "hash-1",
      expires: new Date(Date.now() + 60_000),
    });
    const used = await adapter.useVerificationToken!({
      identifier: "owner@example.com",
      token: "hash-1",
    });
    expect(used?.token).toBe("hash-1");
    expect(
      await adapter.useVerificationToken!({
        identifier: "owner@example.com",
        token: "hash-1",
      }),
    ).toBeNull();
  });

  it("links Google and email accounts to the same user without email-only merge inventing ids", async () => {
    const kv = new MemoryKv();
    const adapter = KvAdapter(kv);
    const user = await adapter.createUser!({
      email: "same@example.com",
      emailVerified: new Date(),
      name: null,
      image: null,
      id: "x",
    });
    await adapter.linkAccount!({
      userId: user.id,
      type: "email",
      provider: "email",
      providerAccountId: "same@example.com",
    });
    await adapter.linkAccount!({
      userId: user.id,
      type: "oidc",
      provider: "google",
      providerAccountId: "google-sub-1",
    });
    const byGoogle = await adapter.getUserByAccount!({
      provider: "google",
      providerAccountId: "google-sub-1",
    });
    const byEmail = await adapter.getUserByEmail!("same@example.com");
    expect(byGoogle?.id).toBe(user.id);
    expect(byEmail?.id).toBe(user.id);
  });
});
