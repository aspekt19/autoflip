import { loadReport } from "@/io/store";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const report = loadReport(id);
  if (!report) {
    return Response.json(
      { error: "not_found", message: "That report is not on this server. Reports live in local storage and can expire on a fresh deploy." },
      { status: 404 },
    );
  }
  return Response.json(report);
}
