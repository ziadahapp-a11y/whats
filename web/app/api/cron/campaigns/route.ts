import { timingSafeEqual } from "node:crypto";
import { advanceCampaign } from "@/lib/campaign";
import { runtime } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request, secret: string) {
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || new URL(req.url).searchParams.get("key") || "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Resumes the active marketing campaign, if any. A campaign that hit the 24-hour
// recipient cap is "waiting" and only sends again when this endpoint is called after
// its retry time. Call it hourly with ?key=CRON_SECRET (an external scheduler such as
// cron-job.org works on every Vercel plan).
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !authorized(req, secret)) return new Response("unauthorized", { status: 401 });
  const { store, graph } = runtime();
  const id = await store.mkGet<string>("camp:active");
  if (!id) return Response.json({ active: null });
  const view = await advanceCampaign({ graph, store }, id);
  return Response.json({ active: id, status: view.status });
}
