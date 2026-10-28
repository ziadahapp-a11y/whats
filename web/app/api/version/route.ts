import { versionInfo } from "@/lib/version";

export const dynamic = "force-dynamic";

// Public on purpose: it only says which code this deployment runs, so `scripts/customers.mjs` can compare it with main.
export async function GET() {
  return Response.json(versionInfo(), { headers: { "Cache-Control": "no-store" } });
}
