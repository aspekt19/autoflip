import { originOf } from "@/server/secrets";
import { agentPaymentInfo } from "@/server/x402-payments";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return Response.json(agentPaymentInfo(originOf(request)), {
    headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
  });
}
