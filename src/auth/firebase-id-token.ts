import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/** Google's public keys for Firebase Auth ID tokens. No service account. */
export const FIREBASE_SECURETOKEN_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const remoteJwks = createRemoteJWKSet(new URL(FIREBASE_SECURETOKEN_JWKS_URL));

/** Firebase Admin allows five minutes of clock skew. ID tokens last one hour. */
const CLOCK_SKEW_SEC = 5 * 60;
const MAX_ID_TOKEN_LIFETIME_SEC = 60 * 60;

function numericDate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

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
 * The project id is the caller's (env), never a claim inside the token.
 * Checks RS256, iss `https://securetoken.google.com/<projectId>`, aud exactly
 * that project id, exp/iat/auth_time, a non-empty sub, and email_verified === true.
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
  if (!projectId || /[\s/\\]/.test(projectId) || !idToken.trim()) throw new FirebaseTokenError("invalid");
  const issuer = `https://securetoken.google.com/${projectId}`;

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(idToken, options.getKey ?? remoteJwks, {
      issuer,
      audience: projectId,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_SKEW_SEC,
      maxTokenAge: MAX_ID_TOKEN_LIFETIME_SEC,
      requiredClaims: ["exp", "iat", "auth_time", "sub", "aud", "iss"],
      currentDate: options.now,
    });
    if (verified.protectedHeader.alg !== "RS256") throw new FirebaseTokenError("invalid");
    payload = verified.payload;
  } catch (error) {
    if (error instanceof FirebaseTokenError) throw error;
    throw failureFromJose(error);
  }

  const nowSec = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (payload.iss !== issuer) throw new FirebaseTokenError("issuer");
  // jose treats aud arrays as a match if any entry equals the project. Firebase aud is one string.
  if (typeof payload.aud !== "string" || payload.aud !== projectId) throw new FirebaseTokenError("audience");

  const exp = numericDate(payload.exp);
  const iat = numericDate(payload.iat);
  const authTime = numericDate(payload.auth_time);
  if (exp === null || iat === null || authTime === null) throw new FirebaseTokenError("invalid");
  if (exp <= nowSec - CLOCK_SKEW_SEC) throw new FirebaseTokenError("expired");
  if (iat > nowSec + CLOCK_SKEW_SEC || authTime > nowSec + CLOCK_SKEW_SEC) throw new FirebaseTokenError("invalid");
  if (authTime > iat + CLOCK_SKEW_SEC) throw new FirebaseTokenError("invalid");
  if (exp <= iat || exp - iat > MAX_ID_TOKEN_LIFETIME_SEC + CLOCK_SKEW_SEC) throw new FirebaseTokenError("invalid");
  if (typeof payload.sub !== "string" || payload.sub.trim() === "" || /[\u0000-\u001F\u007F]/.test(payload.sub)) {
    throw new FirebaseTokenError("invalid");
  }
  if (payload.email_verified !== true) throw new FirebaseTokenError("unverified_email");
  if (typeof payload.email !== "string" || !payload.email.includes("@")) {
    throw new FirebaseTokenError("missing_email");
  }

  return { email: payload.email.trim().toLowerCase(), uid: payload.sub };
}
