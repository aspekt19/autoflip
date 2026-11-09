import { generateKeyPair, SignJWT } from "jose";
import { createSecretKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FirebaseTokenError, verifyFirebaseIdToken } from "./firebase-id-token";

const PROJECT = "lemonless";
const NOW = new Date("2026-06-01T12:00:00.000Z");

async function keys() {
  return generateKeyPair("RS256");
}

const IAT = Math.floor(NOW.getTime() / 1000) - 30;

async function token(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  opts?: { iss?: string; aud?: string | string[]; exp?: number; iat?: number; alg?: "RS256" },
) {
  const iat = opts?.iat ?? IAT;
  const builder = new SignJWT({ auth_time: iat, ...claims })
    .setProtectedHeader({ alg: opts?.alg ?? "RS256" })
    .setIssuer(opts?.iss ?? `https://securetoken.google.com/${PROJECT}`)
    .setAudience(opts?.aud ?? PROJECT)
    .setSubject(typeof claims.sub === "string" ? claims.sub : "firebase-uid-1")
    .setIssuedAt(iat)
    .setExpirationTime(opts?.exp ?? iat + 600);
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
    const exp = Math.floor(NOW.getTime() / 1000) - 600;
    const jwt = await token(
      privateKey,
      { email: "buyer@example.com", email_verified: true },
      { exp, iat: exp - 300 },
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

  it("rejects a missing auth_time, a future auth_time, and an empty sub", async () => {
    const { publicKey, privateKey } = await keys();
    const missingAuthTime = await new SignJWT({ email: "buyer@example.com", email_verified: true })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(`https://securetoken.google.com/${PROJECT}`)
      .setAudience(PROJECT)
      .setSubject("uid-1")
      .setIssuedAt(IAT)
      .setExpirationTime("10m")
      .sign(privateKey);
    await expect(verifyFirebaseIdToken(missingAuthTime, { projectId: PROJECT, getKey: publicKey, now: NOW })).rejects.toMatchObject({
      code: "invalid",
    });

    const futureAuth = await token(privateKey, { email: "buyer@example.com", email_verified: true, auth_time: IAT + 3600 });
    await expect(verifyFirebaseIdToken(futureAuth, { projectId: PROJECT, getKey: publicKey, now: NOW })).rejects.toMatchObject({
      code: "invalid",
    });

    const blankSub = await token(privateKey, { email: "buyer@example.com", email_verified: true, sub: "   " });
    await expect(verifyFirebaseIdToken(blankSub, { projectId: PROJECT, getKey: publicKey, now: NOW })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("rejects a future iat and an ID token that lives longer than an hour", async () => {
    const { publicKey, privateKey } = await keys();
    const futureIat = await token(
      privateKey,
      { email: "buyer@example.com", email_verified: true },
      { iat: Math.floor(NOW.getTime() / 1000) + 3600 },
    );
    await expect(verifyFirebaseIdToken(futureIat, { projectId: PROJECT, getKey: publicKey, now: NOW })).rejects.toBeInstanceOf(
      FirebaseTokenError,
    );

    const longLived = await token(
      privateKey,
      { email: "buyer@example.com", email_verified: true },
      { exp: IAT + 24 * 60 * 60 },
    );
    await expect(verifyFirebaseIdToken(longLived, { projectId: PROJECT, getKey: publicKey, now: NOW })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("rejects an audience array, alg none, and HS256 even when the project id is also a claim", async () => {
    const { publicKey, privateKey } = await keys();
    const audArray = await token(
      privateKey,
      { email: "buyer@example.com", email_verified: true, projectId: PROJECT },
      { aud: [PROJECT, "other-project"] },
    );
    await expect(verifyFirebaseIdToken(audArray, { projectId: PROJECT, getKey: publicKey, now: NOW })).rejects.toMatchObject({
      code: "audience",
    });

    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({
        iss: `https://securetoken.google.com/${PROJECT}`,
        aud: PROJECT,
        sub: "uid-1",
        iat: IAT,
        exp: IAT + 600,
        auth_time: IAT,
        email: "buyer@example.com",
        email_verified: true,
      }),
    ).toString("base64url");
    await expect(
      verifyFirebaseIdToken(`${header}.${body}.`, { projectId: PROJECT, getKey: publicKey, now: NOW }),
    ).rejects.toBeInstanceOf(FirebaseTokenError);

    const hs = await new SignJWT({
      email: "buyer@example.com",
      email_verified: true,
      auth_time: IAT,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(`https://securetoken.google.com/${PROJECT}`)
      .setAudience(PROJECT)
      .setSubject("uid-1")
      .setIssuedAt(IAT)
      .setExpirationTime("10m")
      .sign(createSecretKey(Buffer.from("not-the-firebase-private-key-material")));
    await expect(verifyFirebaseIdToken(hs, { projectId: PROJECT, getKey: publicKey, now: NOW })).rejects.toBeInstanceOf(
      FirebaseTokenError,
    );
  });

  it("uses the caller project id, not a project id written into the token", async () => {
    const { publicKey, privateKey } = await keys();
    const jwt = await token(privateKey, {
      email: "buyer@example.com",
      email_verified: true,
      projectId: "attacker-project",
    });
    const verified = await verifyFirebaseIdToken(jwt, { projectId: PROJECT, getKey: publicKey, now: NOW });
    expect(verified.email).toBe("buyer@example.com");
    await expect(verifyFirebaseIdToken(jwt, { projectId: "attacker-project", getKey: publicKey, now: NOW })).rejects.toBeInstanceOf(
      FirebaseTokenError,
    );
  });
});
