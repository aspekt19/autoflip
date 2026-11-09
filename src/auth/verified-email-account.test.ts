import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { KvAdapter } from "./kv-adapter";
import { ensureVerifiedEmailAccount } from "./verified-email-account";

describe("ensureVerifiedEmailAccount", () => {
  it("maps Google-style and email-link casing to one user id", async () => {
    const kv = new MemoryKv();
    const first = await ensureVerifiedEmailAccount("Buyer@Example.com", kv);
    const second = await ensureVerifiedEmailAccount("buyer@example.com", kv);
    expect(first?.id).toBeTruthy();
    expect(second?.id).toBe(first?.id);
    expect(second?.email).toBe("buyer@example.com");
    expect(second?.emailVerified).toBeInstanceOf(Date);

    const adapter = KvAdapter(kv);
    await adapter.linkAccount!({
      userId: first!.id,
      type: "oidc",
      provider: "google",
      providerAccountId: "google-sub",
    });
    await adapter.linkAccount!({
      userId: first!.id,
      type: "oidc",
      provider: "email-link",
      providerAccountId: "buyer@example.com",
    });
    const byGoogle = await adapter.getUserByAccount!({ provider: "google", providerAccountId: "google-sub" });
    const byEmail = await adapter.getUserByAccount!({ provider: "email-link", providerAccountId: "buyer@example.com" });
    expect(byGoogle?.id).toBe(first?.id);
    expect(byEmail?.id).toBe(first?.id);
  });

  it("rejects an address that is not an email", async () => {
    const kv = new MemoryKv();
    expect(await ensureVerifiedEmailAccount("not-an-email", kv)).toBeNull();
  });
});
