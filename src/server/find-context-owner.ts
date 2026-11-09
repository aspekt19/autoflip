/**
 * Owner id for a Find search context.
 *
 * /api/match stores the context under the verified Auth.js account
 * (`requireVerifiedAccountForFind` → `session.user.id`).
 * A signed-in browser also has an anonymous `af_uid` cookie. That cookie is a
 * different id. Looking the context up with the cookie misses the key and
 * /api/find/next-check returns "Search context expired or unknown" even though
 * Find just minted the token — the autonomous check loop never starts.
 *
 * With no Auth.js session, the cookie id is the owner so anonymous store and
 * load stay paired.
 */
import { authenticatedAccountId, userId } from "@/server/session";

export async function findContextOwnerId(): Promise<string> {
  const account = await authenticatedAccountId();
  if (account) return account;
  return userId();
}
