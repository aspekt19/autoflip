import { getKv } from "@/io/kv";
import { getRunRequest, patchRunRequest } from "@/server/run-api";
import { authenticatedAccountId, requireVerifiedAccountForFind } from "@/server/session";

export const dynamic = "force-dynamic";

/** Anyone with the link can read the run. The response hides owner-only actions. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const viewerId = await authenticatedAccountId();
  const result = await getRunRequest(getKv(), id, viewerId);
  return Response.json(result.body, { status: result.status });
}

/** Owner-only: add a clarification or a limit the shopper changed. Verdicts are refused. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await requireVerifiedAccountForFind();
  if (!access.ok) return access.response;
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const result = await patchRunRequest(getKv(), id, access.id, body);
  return Response.json(result.body, { status: result.status });
}
