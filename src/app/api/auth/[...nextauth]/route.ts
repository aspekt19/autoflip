import type { NextRequest } from "next/server";
import { handlers } from "@/auth";
import { authIsConfigured } from "@/auth/config";

export const dynamic = "force-dynamic";

function unconfigured() {
  return Response.json(
    {
      error: "auth_unconfigured",
      message: "Authentication is not configured. Paid sign-in is unavailable.",
    },
    { status: 503 },
  );
}

export async function GET(request: NextRequest) {
  if (!authIsConfigured()) return unconfigured();
  return handlers.GET(request);
}

export async function POST(request: NextRequest) {
  if (!authIsConfigured()) return unconfigured();
  return handlers.POST(request);
}
