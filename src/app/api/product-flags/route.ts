import { resolveProductFlags } from "@/domain/product-flags";

export const dynamic = "force-dynamic";

/** Public product surface flags for nav and page gates. No secrets. */
export async function GET() {
  return Response.json({ flags: resolveProductFlags() });
}
