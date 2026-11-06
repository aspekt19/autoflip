import { getKv } from "@/io/kv";
import { listRuns } from "@/server/radar-store";
import { isDemoUser, ledgerOwnerId } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const id = await ledgerOwnerId();
  if (!isDemoUser(id)) {
    return Response.json({ error: "demo_only", message: "The activity log is part of the shared preview." }, { status: 403 });
  }
  return Response.json({ runs: await listRuns(getKv()) });
}
