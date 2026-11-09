import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { FirebaseTokenError, verifyFirebaseIdToken } from "./firebase-id-token";

const PROJECT = "lemonless";
const NOW = new Date("2026-06-01T12:00:00.000Z");

async function keys() {
  return generateKeyPair("RS256");
}

async function token(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  opts?: { iss?: string; aud?: string; exp?: number | string },
) {
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts?.iss ?? `https://securetoken.google.com/${PROJECT}`)
    .setAudience(opts?.aud ?? PROJECT)
    .setSubject(typeof claims.sub === "string" ? claims.sub : "firebase-uid-1")
    .setIssuedAt(Math.floor(NOW.getTime() / 1000) - 30);
  if (typeof opts?.exp === "number") builder.setExpirationTime(opts.exp);
  else builder.setExpirationTime(opts?.exp ?? "10m");
  return builder.sign(privateKey);
}

describe("verifyFirebaseIdToken", () => {
  it("accepts a valid email-link token and lowercases the email", async () => {
    const { publicKey, privateKey } = await keys();
    const jwt = await token(privateKey, {
      email: "Buyer@Example.com",
      email_verified: true,
      sub: "uid-1",
    });
    const verified = await verifyFirebaseIdToken(jwt, { projectId: PROJECT, getKey: publicKey, now: NOW });
    expect(verified).toEqual({ email: "buyer@example.com", uid: "uid-1" });
  });

  it("rejects a wrong audience", async () => {
    const { publicKey, privateKey } = await keys();
    const jwt = await token(
      privateKey,
      { email: "buyer@example.com", email_verified: true },
      { aud: "other-project" },
    );
    await expect(verifyFirebaseIdToken(jwt, { projectId: PROJECT, getKey: publicKey, now: NOW })).rejects.toMatchObject({
      code: "audience",
    });
  });

  it("rejects a wrong issuer", async () => {
    const { publicKey, privateKey } = await keys();
    const jwt = await token(
      privateKey,
      { email: "buyer@example.com", email_verified: true },
      { iss: "https://securetoken.google.com/other-project" },
    );
    await expect(verifyFirebaseIdToken(jwt, { projectId: PROJECT, getKey: publicKey, now: NOW })).rejects.toMatchObject({
      code: "issuer",
    });
  });

  it("rejects an expired token", async () => {
    const { publicKey, privateKey } = await keys();
    const jwt = await token(
      privateKey,
      { email: "buyer@example.com", email_verified: true },
      { exp: Math.floor(NOW.getTime() / 1000) - 60 },
    );
    await expect(verifyFirebaseIdToken(jwt, { projectId: PROJECT, getKey: publicKey, now: NOW })).rejects.toBeInstanceOf(
      FirebaseTokenError,
    );
    await expect(verifyFirebaseIdToken(jwt, { projectId: PROJECT, getKey: publicKey, now: NOW })).rejects.toMatchObject({
      code: "expired",
    });
  });

  it("rejects email_verified false", async () => {
    const { publicKey, privateKey } = await keys();
    const jwt = await token(privateKey, { email: "buyer@example.com", email_verified: false });
    await expect(verifyFirebaseIdToken(jwt, { projectId: PROJECT, getKey: publicKey, now: NOW })).rejects.toMatchObject({
      code: "unverified_email",
    });
  });
});
