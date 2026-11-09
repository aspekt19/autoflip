import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import type { Provider } from "next-auth/providers";
import { getKv } from "@/io/kv";
import { moneyAuthStorageOk } from "@/io/kv-guard";
import {
  authIsConfigured,
  authSecretConfigured,
  emailAuthConfigured,
  firebasePublicConfig,
  googleAuthConfigured,
  safeAuthCallbackUrl,
} from "@/auth/config";
import { verifyFirebaseIdToken } from "@/auth/firebase-id-token";
import { KvAdapter } from "@/auth/kv-adapter";
import { consumeRateLimit, emailSignInRateKey } from "@/auth/rate-limit";
import { verifiedGoogleEmail } from "@/auth/email-address";
import { ensureVerifiedEmailAccount } from "@/auth/verified-email-account";

function buildProviders(): Provider[] {
  const providers: Provider[] = [];
  if (googleAuthConfigured()) {
    providers.push(
      Google({
        // Same verified email as an email-link account joins that Lemonless user.
        // signIn() below rejects Google unless the provider says email_verified.
        allowDangerousEmailAccountLinking: true,
        authorization: {
          params: {
            prompt: "select_account",
            access_type: "online",
            response_type: "code",
          },
        },
      }),
    );
  }
  if (emailAuthConfigured()) {
    providers.push(
      Credentials({
        id: "email-link",
        name: "Email",
        credentials: {
          idToken: { label: "ID token", type: "text" },
        },
        authorize: async (credentials) => {
          const idToken = typeof credentials?.idToken === "string" ? credentials.idToken.trim() : "";
          const projectId = firebasePublicConfig()?.projectId;
          if (!idToken || !projectId || !moneyAuthStorageOk()) return null;
          let email: string;
          try {
            email = (await verifyFirebaseIdToken(idToken, { projectId })).email;
          } catch {
            return null;
          }
          const kv = getKv();
          const limited = await consumeRateLimit(kv, emailSignInRateKey(email, "finish"), 10, 15 * 60_000);
          if (!limited.ok) return null;
          const account = await ensureVerifiedEmailAccount(email, kv);
          if (!account?.emailVerified) return null;
          const adapter = KvAdapter(kv);
          await adapter.linkAccount?.({
            userId: account.id,
            type: "email",
            provider: "email-link",
            providerAccountId: account.email,
          });
          return {
            id: account.id,
            email: account.email,
            name: account.name,
            image: account.image,
            emailVerified: account.emailVerified,
          };
        },
      }),
    );
  }
  return providers;
}

const nextAuth = NextAuth({
  trustHost: true,
  secret: process.env.AUTH_SECRET,
  adapter: KvAdapter(getKv()),
  // Credentials cannot use database sessions. Users still live in the KV adapter.
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 24 * 30,
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: buildProviders(),
  callbacks: {
    async redirect({ url, baseUrl }) {
      if (url.startsWith("/")) {
        const safe = safeAuthCallbackUrl(url);
        return safe ? `${baseUrl}${safe}` : baseUrl;
      }
      try {
        const target = new URL(url);
        if (target.origin === new URL(baseUrl).origin) {
          const safe = safeAuthCallbackUrl(`${target.pathname}${target.search}`);
          return safe ? `${baseUrl}${safe}` : baseUrl;
        }
      } catch {
        /* fall through */
      }
      return baseUrl;
    },
    async jwt({ token, user, account, profile }) {
      if (user?.id) token.id = user.id;
      if (typeof user?.email === "string") token.email = user.email.toLowerCase();
      if (user?.emailVerified) token.emailVerified = new Date(user.emailVerified).toISOString();

      const kv = getKv();
      if (account?.provider === "google") {
        const email = verifiedGoogleEmail(
          profile as { email?: string | null; email_verified?: unknown } | undefined,
          typeof user?.email === "string" ? user.email : typeof token.email === "string" ? token.email : null,
        );
        if (!email) {
          token.emailVerified = null;
          return token;
        }
        const stamp = new Date();
        token.email = email;
        token.emailVerified = stamp.toISOString();
        try {
          const canonical = await ensureVerifiedEmailAccount(email, kv);
          if (canonical?.id) {
            token.id = canonical.id;
            if (account.providerAccountId) {
              await KvAdapter(kv).linkAccount?.({
                userId: canonical.id,
                type: "oidc",
                provider: "google",
                providerAccountId: account.providerAccountId,
              });
            }
          }
        } catch {
          /* Keep the adapter id already on the token. */
        }
      }

      if (account?.provider === "email-link" && typeof token.email === "string") {
        try {
          const canonical = await ensureVerifiedEmailAccount(token.email, kv);
          if (canonical?.id) token.id = canonical.id;
        } catch {
          /* authorize() already bound this sign-in to the email account. */
        }
      }

      // Later session reads follow the email index, so a raced duplicate id cannot keep its own quota.
      if (!account && typeof token.email === "string" && token.emailVerified) {
        try {
          const existing = await KvAdapter(kv).getUserByEmail!(token.email);
          if (existing?.id && existing.emailVerified) token.id = existing.id;
        } catch {
          /* Keep the id already in the signed token. */
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        const id = typeof token.id === "string" ? token.id : typeof token.sub === "string" ? token.sub : "";
        session.user.id = id;
        if (typeof token.email === "string") session.user.email = token.email;
        session.user.emailVerified =
          typeof token.emailVerified === "string" && token.emailVerified ? new Date(token.emailVerified) : null;
      }
      return session;
    },
    async signIn({ user, account, profile }) {
      if (!authIsConfigured()) return false;
      if (!moneyAuthStorageOk()) return false;
      if (account?.provider === "google") {
        const email = verifiedGoogleEmail(
          profile as { email?: string | null; email_verified?: unknown } | undefined,
          user.email,
        );
        if (!email) {
          if (account.providerAccountId) {
            try {
              await KvAdapter(getKv()).unlinkAccount?.({
                provider: "google",
                providerAccountId: account.providerAccountId,
              });
            } catch {
              /* Still refuse the session. */
            }
          }
          return false;
        }
        return true;
      }
      if (account?.provider === "email-link") {
        return Boolean(user.email) && Boolean(user.emailVerified);
      }
      return false;
    },
  },
});

export const { handlers, auth, signIn, signOut } = nextAuth;

export function assertAuthRuntimeReady(): { ok: true } | { ok: false; error: string; message: string } {
  if (!authSecretConfigured()) {
    return {
      ok: false,
      error: "auth_unconfigured",
      message: "Sign-in is not configured (AUTH_SECRET missing).",
    };
  }
  if (!authIsConfigured()) {
    return {
      ok: false,
      error: "auth_unconfigured",
      message: "Sign-in is not configured (no Google or email provider credentials).",
    };
  }
  if (!moneyAuthStorageOk()) {
    return {
      ok: false,
      error: "money_store_unconfigured",
      message: "Persistent Upstash KV is required for authentication on this host.",
    };
  }
  return { ok: true };
}
