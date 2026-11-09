import type {
  Adapter,
  AdapterAccount,
  AdapterSession,
  AdapterUser,
  VerificationToken,
} from "@auth/core/adapters";
import type { Kv } from "@/io/kv";
import { canonicalAccountEmail } from "./email-address";

function userKey(id: string) {
  return `auth:user:${id}`;
}
function emailKey(email: string) {
  const normalized = canonicalAccountEmail(email) ?? email.trim().toLowerCase().normalize("NFC");
  return `auth:email:${normalized}`;
}
function accountKey(provider: string, providerAccountId: string) {
  return `auth:account:${provider}:${providerAccountId}`;
}
function userAccountsKey(userId: string) {
  return `auth:user-accounts:${userId}`;
}
function sessionKey(sessionToken: string) {
  return `auth:session:${sessionToken}`;
}
function verificationKey(identifier: string, token: string) {
  return `auth:verification:${identifier.trim().toLowerCase()}:${token}`;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function reviveUser(raw: AdapterUser & { emailVerified?: string | Date | null }): AdapterUser {
  return {
    ...raw,
    emailVerified: raw.emailVerified ? new Date(raw.emailVerified) : null,
  };
}

function reviveSession(raw: AdapterSession & { expires: string | Date }): AdapterSession {
  return { ...raw, expires: new Date(raw.expires) };
}

function reviveToken(raw: VerificationToken & { expires: string | Date }): VerificationToken {
  return { ...raw, expires: new Date(raw.expires) };
}

async function userByEmail(kv: Kv, email: string): Promise<AdapterUser | null> {
  const id = await kv.get(emailKey(email));
  if (!id) return null;
  const raw = parseJson<AdapterUser & { emailVerified?: string | Date | null }>(await kv.get(userKey(id)));
  return raw ? reviveUser(raw) : null;
}

async function stampEmailVerified(
  kv: Kv,
  user: AdapterUser,
  email: string,
  emailVerified: Date | null | undefined,
): Promise<AdapterUser> {
  if (!emailVerified || user.emailVerified) return user;
  const next: AdapterUser = { ...user, email, emailVerified };
  await kv.set(userKey(user.id), JSON.stringify(next));
  return next;
}

async function readAccountList(kv: Kv, userId: string): Promise<string[]> {
  const parsed = parseJson<string[]>(await kv.get(userAccountsKey(userId)));
  return Array.isArray(parsed) ? parsed : [];
}

async function writeAccountList(kv: Kv, userId: string, keys: string[]): Promise<void> {
  await kv.set(userAccountsKey(userId), JSON.stringify([...new Set(keys)]));
}

/**
 * Auth.js adapter backed by the existing Lemonless KV (Upstash / file / memory).
 * No separate database provisioning.
 */
export function KvAdapter(kv: Kv): Adapter {
  return {
    async createUser(data) {
      const email = canonicalAccountEmail(data.email);
      if (!email) throw new Error("auth_email_invalid");
      const lockKey = `auth:email-claim:${email}`;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const existing = await userByEmail(kv, email);
        if (existing) return stampEmailVerified(kv, existing, email, data.emailVerified);
        const claimed = await kv.setNx(lockKey, "1", { ttlMs: 8000 });
        if (!claimed) {
          await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
          continue;
        }
        try {
          const again = await userByEmail(kv, email);
          if (again) return stampEmailVerified(kv, again, email, data.emailVerified);
          const id = crypto.randomUUID();
          const user: AdapterUser = {
            id,
            name: data.name ?? null,
            email,
            emailVerified: data.emailVerified ?? null,
            image: data.image ?? null,
          };
          await kv.set(userKey(id), JSON.stringify(user));
          await kv.set(emailKey(email), id);
          return user;
        } finally {
          await kv.delete(lockKey);
        }
      }
      const last = await userByEmail(kv, email);
      if (last) return stampEmailVerified(kv, last, email, data.emailVerified);
      throw new Error("auth_email_busy");
    },

    async getUser(id) {
      const raw = parseJson<AdapterUser & { emailVerified?: string | Date | null }>(await kv.get(userKey(id)));
      return raw ? reviveUser(raw) : null;
    },

    async getUserByEmail(email) {
      return userByEmail(kv, email);
    },

    async getUserByAccount({ provider, providerAccountId }) {
      const account = parseJson<AdapterAccount>(await kv.get(accountKey(provider, providerAccountId)));
      if (!account?.userId) return null;
      const raw = parseJson<AdapterUser & { emailVerified?: string | Date | null }>(await kv.get(userKey(account.userId)));
      return raw ? reviveUser(raw) : null;
    },

    async updateUser(data) {
      const existing = parseJson<AdapterUser & { emailVerified?: string | Date | null }>(await kv.get(userKey(data.id)));
      if (!existing) throw new Error("auth_user_missing");
      const priorEmail = existing.email;
      const nextEmail = canonicalAccountEmail(data.email ?? existing.email);
      if (!nextEmail) throw new Error("auth_email_invalid");
      const priorNormalized = canonicalAccountEmail(priorEmail) ?? priorEmail.toLowerCase();
      const owner = nextEmail === priorNormalized ? existing.id : await kv.get(emailKey(nextEmail));
      const email = owner && owner !== existing.id ? priorEmail : nextEmail;
      const next: AdapterUser = reviveUser({
        ...existing,
        ...data,
        email,
        emailVerified:
          data.emailVerified === undefined
            ? existing.emailVerified
            : data.emailVerified,
      });
      await kv.set(userKey(next.id), JSON.stringify(next));
      if (priorEmail && priorEmail.toLowerCase() !== next.email.toLowerCase()) {
        const priorOwner = await kv.get(emailKey(priorEmail));
        if (priorOwner === next.id) await kv.delete(emailKey(priorEmail));
      }
      if (next.email && (!owner || owner === next.id)) await kv.set(emailKey(next.email), next.id);
      return next;
    },

    async deleteUser(userId) {
      const user = parseJson<AdapterUser>(await kv.get(userKey(userId)));
      const accounts = await readAccountList(kv, userId);
      for (const key of accounts) await kv.delete(key);
      await kv.delete(userAccountsKey(userId));
      if (user?.email) await kv.delete(emailKey(user.email));
      await kv.delete(userKey(userId));
    },

    async linkAccount(account) {
      const key = accountKey(account.provider, account.providerAccountId);
      await kv.set(key, JSON.stringify(account));
      const list = await readAccountList(kv, account.userId);
      list.push(key);
      await writeAccountList(kv, account.userId, list);
      return account;
    },

    async unlinkAccount({ provider, providerAccountId }) {
      const key = accountKey(provider, providerAccountId);
      const account = parseJson<AdapterAccount>(await kv.get(key));
      await kv.delete(key);
      if (account?.userId) {
        const list = await readAccountList(kv, account.userId);
        await writeAccountList(
          kv,
          account.userId,
          list.filter((item) => item !== key),
        );
      }
      return account ?? undefined;
    },

    async getAccount(providerAccountId, provider) {
      return parseJson<AdapterAccount>(await kv.get(accountKey(provider, providerAccountId)));
    },

    async createSession({ sessionToken, userId, expires }) {
      const session: AdapterSession = { sessionToken, userId, expires };
      await kv.set(sessionKey(sessionToken), JSON.stringify(session));
      return session;
    },

    async getSessionAndUser(sessionToken) {
      const sessionRaw = parseJson<AdapterSession & { expires: string | Date }>(
        await kv.get(sessionKey(sessionToken)),
      );
      if (!sessionRaw) return null;
      const session = reviveSession(sessionRaw);
      if (session.expires.getTime() <= Date.now()) {
        await kv.delete(sessionKey(sessionToken));
        return null;
      }
      const userRaw = parseJson<AdapterUser & { emailVerified?: string | Date | null }>(
        await kv.get(userKey(session.userId)),
      );
      if (!userRaw) return null;
      return { session, user: reviveUser(userRaw) };
    },

    async updateSession(data) {
      const existing = parseJson<AdapterSession & { expires: string | Date }>(
        await kv.get(sessionKey(data.sessionToken)),
      );
      if (!existing) return null;
      const next = reviveSession({ ...existing, ...data });
      await kv.set(sessionKey(data.sessionToken), JSON.stringify(next));
      return next;
    },

    async deleteSession(sessionToken) {
      const existing = parseJson<AdapterSession & { expires: string | Date }>(
        await kv.get(sessionKey(sessionToken)),
      );
      await kv.delete(sessionKey(sessionToken));
      return existing ? reviveSession(existing) : null;
    },

    async createVerificationToken(verificationToken) {
      await kv.set(
        verificationKey(verificationToken.identifier, verificationToken.token),
        JSON.stringify(verificationToken),
      );
      return verificationToken;
    },

    async useVerificationToken({ identifier, token }) {
      const key = verificationKey(identifier, token);
      const raw = parseJson<VerificationToken & { expires: string | Date }>(await kv.get(key));
      await kv.delete(key);
      if (!raw) return null;
      return reviveToken(raw);
    },
  };
}
