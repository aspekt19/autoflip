import { getKv } from "@/io/kv";
import { listFavoriteReportIds, setFavoriteReport } from "@/io/persist-report";
import { userId } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const id = await userId();
  return Response.json({ favoriteIds: await listFavoriteReportIds(getKv(), id) });
}

async function update(request: Request, favorite: boolean) {
  const body = (await request.json().catch(() => null)) as { reportId?: unknown } | null;
  const reportId = typeof body?.reportId === "string" ? body.reportId : "";
  if (!reportId) {
    return Response.json({ error: "invalid_report", message: "Choose a saved vehicle report." }, { status: 400 });
  }
  const id = await userId();
  const result = await setFavoriteReport(getKv(), id, reportId, favorite);
  if (!result.ok) {
    return Response.json({ error: "report_not_owned", message: "Save a report from this browser before adding it to saved cars." }, { status: 404 });
  }
  return Response.json({ favoriteIds: result.favoriteIds });
}

export async function POST(request: Request) {
  return update(request, true);
}

export async function DELETE(request: Request) {
  return update(request, false);
}
