import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Nodemailer from "next-auth/providers/nodemailer";
import type { Provider } from "next-auth/providers";
import { getKv } from "@/io/kv";
import { moneyAuthStorageOk } from "@/io/kv-guard";
import {
  authIsConfigured,
  authSecretConfigured,
  emailAuthConfigured,
  emailUsesTestInbox,
  googleAuthConfigured,
  isProductionRuntime,
  safeAuthCallbackUrl,
} from "@/auth/config";
import { KvAdapter } from "@/auth/kv-adapter";
import { sendMagicLinkEmail } from "@/auth/email-transport";
import { consumeRateLimit, emailSignInRateKey } from "@/auth/rate-limit";

function buildProviders(): Provider[] {
  const providers: Provider[] = [];
  if (googleAuthConfigured()) {
    providers.push(
      Google({
        // Never auto-merge distinct provider accounts solely because emails match.
        // Email magic-link recovers via getUserByEmail; Google links only when the
        // same Google account already exists, or via an explicit signed-in link flow later.
        allowDangerousEmailAccountLinking: false,
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
      Nodemailer({
        id: "email",
        name: "Email",
        server: process.env.EMAIL_SERVER || "smtp://127.0.0.1:1",
        from: process.env.EMAIL_FROM || "noreply@localhost",
        maxAge: 60 * 15, // 15 minutes — one-use expiring tokens
        async sendVerificationRequest({ identifier, url }) {
          if (isProductionRuntime() && process.env.AUTH_EMAIL_MODE?.trim() === "test") {
            throw new Error("email_test_mode_forbidden_in_production");
          }
          if (!moneyAuthStorageOk()) {
            throw new Error("money_store_unconfigured");
          }
          const kv = getKv();
          const limited = await consumeRateLimit(kv, emailSignInRateKey(identifier, "signin"), 5, 15 * 60_000);
          if (!limited.ok) {
            throw new Error("email_rate_limited");
          }
          await sendMagicLinkEmail({ kv, to: identifier, url });
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
  session: {
    strategy: "database",
    maxAge: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  pages: {
    signIn: "/login",
    verifyRequest: "/login?verify=1",
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
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
        (session.user as { emailVerified?: Date | null }).emailVerified = user.emailVerified;
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
      if (account?.provider === "email") {
        if (isProductionRuntime() && emailUsesTestInbox()) return false;
        return Boolean(user.email);
      }
      return false;
    },
  },
  events: {
    async signIn({ user, account, profile }) {
      if (account?.provider === "google" && user.id) {
        const verified = Boolean((profile as { email_verified?: boolean } | undefined)?.email_verified);
        if (verified) {
          const adapter = KvAdapter(getKv());
          await adapter.updateUser?.({ id: user.id, emailVerified: new Date() });
        }
      }
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
