import { extractVin } from "@/domain/vin";
import { getKv } from "@/io/kv";
import { findUserReport } from "@/io/persist-report";
import { ledgerOwnerId } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const vin = extractVin(new URL(request.url).searchParams.get("vin") ?? "");
  if (!vin) return Response.json({ id: null });
  const id = await findUserReport(getKv(), await ledgerOwnerId(), vin);
  return Response.json({ id });
}
