import nodemailer from "nodemailer";
import type { Kv } from "@/io/kv";
import { emailUsesTestInbox, isProductionRuntime } from "./config";

export type OutboundMagicLink = {
  to: string;
  url: string;
  from: string;
  subject: string;
  sentAt: string;
};

function inboxKey(email: string) {
  return `auth:test-inbox:${email.trim().toLowerCase()}`;
}

/** Read the latest magic-link stub for tests. Never used as payment proof. */
export async function readTestInbox(kv: Kv, email: string): Promise<OutboundMagicLink | null> {
  const raw = await kv.get(inboxKey(email));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OutboundMagicLink;
  } catch {
    return null;
  }
}

export async function clearTestInbox(kv: Kv, email: string): Promise<void> {
  await kv.delete(inboxKey(email));
}

/**
 * Deliver a magic link. Test inbox is local/CI only — hard-refused in production.
 */
export async function sendMagicLinkEmail(opts: {
  kv: Kv;
  to: string;
  url: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = opts.env ?? process.env;
  if (isProductionRuntime(env) && (env.AUTH_EMAIL_MODE?.trim() === "test" || emailUsesTestInbox(env))) {
    throw new Error("email_test_mode_forbidden_in_production");
  }

  const from = env.EMAIL_FROM?.trim() || "noreply@localhost";
  const subject = "Sign in to Lemonless";
  const payload: OutboundMagicLink = {
    to: opts.to,
    url: opts.url,
    from,
    subject,
    sentAt: new Date().toISOString(),
  };

  if (emailUsesTestInbox(env)) {
    await opts.kv.set(inboxKey(opts.to), JSON.stringify(payload));
    return;
  }

  const server = env.EMAIL_SERVER?.trim();
  if (!server) {
    throw new Error("email_unconfigured");
  }
  const transport = nodemailer.createTransport(server);
  await transport.sendMail({
    to: opts.to,
    from,
    subject,
    text: `Sign in to Lemonless:\n${opts.url}\n\nThis link expires and can be used once.`,
    html: `<p>Sign in to Lemonless:</p><p><a href="${opts.url}">Continue</a></p><p>This link expires and can be used once.</p>`,
  });
}
