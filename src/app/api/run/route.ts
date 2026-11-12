import { getKv } from "@/io/kv";
import { createRunRequest } from "@/server/run-api";
import { requireVerifiedAccountForFind } from "@/server/session";

export const dynamic = "force-dynamic";

/** Start a Find, Resale, or Check run. The server owns the record. */
export async function POST(request: Request) {
  const access = await requireVerifiedAccountForFind();
  if (!access.ok) return access.response;
  const body = await request.json().catch(() => null);
  const result = await createRunRequest(getKv(), access.id, body);
  return Response.json(result.body, { status: result.status });
}
