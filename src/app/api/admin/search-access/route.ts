import { KvAdapter } from "@/auth/kv-adapter";
import { getKv } from "@/io/kv";
import { grantAdditionalTrialSearchSessions } from "@/server/search-billing-gate";
import { requireVerifiedAccountForFind } from "@/server/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const access = await requireVerifiedAccountForFind();
  if (!access.ok) return access.response;
  if (!access.isAdmin) {
    return Response.json({ error: "admin_required", message: "Admin access is required." }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as
    | { email?: unknown; additionalSessions?: unknown }
    | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const additionalSessions = body?.additionalSessions;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "invalid_email", message: "Enter the registered account email." }, { status: 400 });
  }
  if (!Number.isInteger(additionalSessions) || (additionalSessions as number) < 1 || (additionalSessions as number) > 100) {
    return Response.json({ error: "invalid_amount", message: "Grant between 1 and 100 additional search sessions." }, { status: 400 });
  }

  const kv = getKv();
  const user = await KvAdapter(kv).getUserByEmail?.(email);
  if (!user?.id || !user.emailVerified || !user.email) {
    return Response.json(
      { error: "account_not_found", message: "No registered account with a verified email was found." },
      { status: 404 },
    );
  }

  const totalExtraSessions = await grantAdditionalTrialSearchSessions(kv, user.id, additionalSessions as number);
  return Response.json({
    ok: true,
    email: user.email,
    additionalSessionsGranted: additionalSessions,
    totalExtraSessions,
    scope: "Find and Resale combined",
  });
}
