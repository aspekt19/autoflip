import type { NextRequest } from "next/server";
import { handlers } from "@/auth";
import { authIsConfigured } from "@/auth/config";
import { requireMoneyAuthStore } from "@/io/kv-guard";

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
  const store = requireMoneyAuthStore();
  if (!store.ok) return store.response;
  return handlers.GET(request);
}

export async function POST(request: NextRequest) {
  if (!authIsConfigured()) return unconfigured();
  const store = requireMoneyAuthStore();
  if (!store.ok) return store.response;
  return handlers.POST(request);
}
