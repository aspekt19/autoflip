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

      if (account?.provider === "google") {
        const verified = Boolean((profile as { email_verified?: boolean } | undefined)?.email_verified);
        if (verified) {
          const stamp = new Date();
          token.emailVerified = stamp.toISOString();
          const id = typeof token.id === "string" ? token.id : user?.id;
          if (id) {
            try {
              await KvAdapter(getKv()).updateUser?.({ id, emailVerified: stamp });
            } catch {
              /* Session still carries the verified stamp for this sign-in. */
            }
          }
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
        const verified = Boolean((profile as { email_verified?: boolean } | undefined)?.email_verified);
        return Boolean(user.email) && verified;
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
