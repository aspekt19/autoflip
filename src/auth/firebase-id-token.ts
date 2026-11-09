import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/** Google's public keys for Firebase Auth ID tokens. No service account. */
export const FIREBASE_SECURETOKEN_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const remoteJwks = createRemoteJWKSet(new URL(FIREBASE_SECURETOKEN_JWKS_URL));

export type FirebaseTokenFailure = "expired" | "audience" | "issuer" | "unverified_email" | "missing_email" | "invalid";

export class FirebaseTokenError extends Error {
  readonly code: FirebaseTokenFailure;

  constructor(code: FirebaseTokenFailure) {
    super(code);
    this.name = "FirebaseTokenError";
    this.code = code;
  }
}

export type VerifiedFirebaseEmail = {
  /** Lowercased address from the token. This is the Lemonless account identity. */
  email: string;
  uid: string;
};

function failureFromJose(error: unknown): FirebaseTokenError {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : "";
  const claim = error && typeof error === "object" && "claim" in error ? String((error as { claim?: string }).claim) : "";
  if (code === "ERR_JWT_EXPIRED") return new FirebaseTokenError("expired");
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED" && claim === "aud") return new FirebaseTokenError("audience");
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED" && claim === "iss") return new FirebaseTokenError("issuer");
  return new FirebaseTokenError("invalid");
}

/**
 * Verify a Firebase Auth ID token (email-link sign-in).
 * Checks signature, expiry, iss `https://securetoken.google.com/<projectId>`,
 * aud `<projectId>`, and `email_verified === true`.
 */
export async function verifyFirebaseIdToken(
  idToken: string,
  options: {
    projectId: string;
    /** Tests pass a local public key. Production uses Google's JWKS. */
    getKey?: JWTVerifyGetKey | CryptoKey;
    now?: Date;
  },
): Promise<VerifiedFirebaseEmail> {
  const projectId = options.projectId.trim();
  if (!projectId || !idToken.trim()) throw new FirebaseTokenError("invalid");

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(idToken, options.getKey ?? remoteJwks, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ["RS256"],
      currentDate: options.now,
    });
    payload = verified.payload;
  } catch (error) {
    throw failureFromJose(error);
  }

  if (payload.email_verified !== true) throw new FirebaseTokenError("unverified_email");
  if (typeof payload.email !== "string" || !payload.email.includes("@")) {
    throw new FirebaseTokenError("missing_email");
  }
  if (typeof payload.sub !== "string" || !payload.sub.trim()) throw new FirebaseTokenError("invalid");

  return { email: payload.email.trim().toLowerCase(), uid: payload.sub };
}
