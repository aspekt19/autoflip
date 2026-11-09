import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { commitFreeCheck, reserveFreeCheck } from "@/io/free-check-quota";
import { verifiedGoogleEmail } from "./email-address";
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
    expect(await ensureVerifiedEmailAccount("a\nb@example.com", kv)).toBeNull();
  });

  it("keeps one id and one monthly free-check counter across provider create and re-sign-in", async () => {
    const kv = new MemoryKv();
    const adapter = KvAdapter(kv);
    const [google, email, again] = await Promise.all([
      adapter.createUser!({
        id: "ignored-google",
        email: "Buyer@Example.com",
        emailVerified: new Date("2026-06-01T00:00:00.000Z"),
        name: null,
        image: null,
      }),
      ensureVerifiedEmailAccount("buyer@example.com", kv),
      adapter.createUser!({
        id: "ignored-again",
        email: "buyer@example.com",
        emailVerified: null,
        name: null,
        image: null,
      }),
    ]);
    expect(email?.id).toBe(google.id);
    expect(again.id).toBe(google.id);

    for (let n = 0; n < 3; n += 1) {
      const reserved = await reserveFreeCheck(kv, google.id, `vin-${n}`);
      expect(reserved.ok).toBe(true);
      await commitFreeCheck(kv, google.id, `vin-${n}`);
    }
    const resigned = await ensureVerifiedEmailAccount("BUYER@example.com", kv);
    expect(resigned?.id).toBe(google.id);
    const fourth = await reserveFreeCheck(kv, resigned!.id, "vin-4");
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.reason).toBe("exhausted");
  });

  it("does not treat a mismatched or unverified Google profile as the account email", () => {
    expect(verifiedGoogleEmail({ email: "Buyer@Example.com", email_verified: true }, "buyer@example.com")).toBe(
      "buyer@example.com",
    );
    expect(verifiedGoogleEmail({ email: "buyer@example.com", email_verified: "true" }, "buyer@example.com")).toBeNull();
    expect(verifiedGoogleEmail({ email: "attacker@example.com", email_verified: true }, "buyer@example.com")).toBeNull();
    expect(verifiedGoogleEmail({ email: "buyer@example.com", email_verified: false }, null)).toBeNull();
  });
});
